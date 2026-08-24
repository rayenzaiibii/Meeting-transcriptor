import os
import sys
import json
import numpy as np
from pathlib import Path
from dotenv import load_dotenv

# Setup paths and environment
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / '.env')
VECTOR_STORE_FILE = BASE_DIR / 'vector_store.json'
CHATS_DB_FILE = BASE_DIR / 'chats_db.json'
TRANSCRIPTS_DIR = BASE_DIR / 'my transcripts'

# --- 1. DJANGO SETTINGS ---
from django.conf import settings
from django.core.management import execute_from_command_line
from django.urls import path
from django.http import JsonResponse, HttpResponseRedirect
from django.views.decorators.csrf import csrf_exempt

if not settings.configured:
    settings.configure(
        DEBUG=True,
        SECRET_KEY='micro-django-secret',
        ROOT_URLCONF=__name__,
        ALLOWED_HOSTS=['*'],
        INSTALLED_APPS=[
            'corsheaders',
        ],
        MIDDLEWARE=[
            'corsheaders.middleware.CorsMiddleware',
            'django.middleware.common.CommonMiddleware',
        ],
        CORS_ALLOWED_ORIGINS=["http://localhost:5173", "http://127.0.0.1:5173"],
        CORS_ALLOW_CREDENTIALS=True,
    )

import django
django.setup()

# --- 2. AUTHENTICATION LOGIC ---
from google_auth_oauthlib.flow import Flow

GLOBAL_SESSION_TOKENS = None
GLOBAL_OAUTH_STATE = {}
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'
os.environ['OAUTHLIB_RELAX_TOKEN_SCOPE'] = '1'

def get_flow():
    client_id = os.environ.get('GOOGLE_CLIENT_ID')
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
    redirect_uri = os.environ.get('GOOGLE_REDIRECT_URI', 'http://localhost:5000/auth/google/callback')
    
    if not client_id or not client_secret:
        raise ValueError("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env")

    return Flow.from_client_config(
        {
            "web": {
                "client_id": client_id,
                "project_id": "meeting-transcriptor",
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                "client_secret": client_secret,
                "redirect_uris": [redirect_uri]
            }
        },
        scopes=[
            'https://www.googleapis.com/auth/meetings.space.readonly'
        ],
        redirect_uri=redirect_uri
    )

@csrf_exempt
def auth_login(request):
    global GLOBAL_OAUTH_STATE
    try:
        flow = get_flow()
        auth_url, state = flow.authorization_url(prompt='consent', access_type='offline')
        GLOBAL_OAUTH_STATE['state'] = state
        GLOBAL_OAUTH_STATE['code_verifier'] = getattr(flow, 'code_verifier', None)
        return HttpResponseRedirect(auth_url)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

@csrf_exempt
def auth_callback(request):
    global GLOBAL_SESSION_TOKENS, GLOBAL_OAUTH_STATE
    try:
        flow = get_flow()
        if GLOBAL_OAUTH_STATE.get('code_verifier'):
            flow.code_verifier = GLOBAL_OAUTH_STATE['code_verifier']
            
        url = request.build_absolute_uri().replace('127.0.0.1', 'localhost')
        flow.fetch_token(authorization_response=url)
        GLOBAL_SESSION_TOKENS = flow.credentials
        return HttpResponseRedirect("http://localhost:5173/")
    except Exception as e:
        print("OAuth Error:", e)
        return JsonResponse({'error': f'Authentication failed: {e}'}, status=400)

def auth_status(request):
    return JsonResponse({'authenticated': GLOBAL_SESSION_TOKENS is not None})


# --- 3. RAG & AI LOGIC ---
from googleapiclient.discovery import build
from google import genai
from google.genai import types

def load_vector_store():
    if VECTOR_STORE_FILE.exists():
        with open(VECTOR_STORE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_vector_store(store):
    with open(VECTOR_STORE_FILE, 'w', encoding='utf-8') as f:
        json.dump(store, f)

def chunk_text(text, chunk_size=500):
    """Split text into rough chunks of words."""
    words = text.split()
    return [' '.join(words[i:i+chunk_size]) for i in range(0, len(words), chunk_size)]

@csrf_exempt
def meet_transcript(request):
    """ONLY harvest transcript from Google Meet API and save to a local .txt file."""
    global GLOBAL_SESSION_TOKENS
    if not GLOBAL_SESSION_TOKENS:
        return JsonResponse({'success': False, 'error': 'Not authenticated.'}, status=401)
    
    space_id = request.GET.get('spaceId')
    if not space_id:
        return JsonResponse({'success': False, 'error': 'spaceId is required.'}, status=400)
        
    try:
        meet = build('meet', 'v2', credentials=GLOBAL_SESSION_TOKENS)
        
        # 1. Fetch Transcripts from Meet API
        records = meet.conferenceRecords().list(filter=f'space.meeting_code = "{space_id}"').execute().get('conferenceRecords', [])
        if not records: return JsonResponse({'success': False, 'error': 'No meeting records found. Make sure the meeting has ended.'}, status=404)
        
        transcripts = meet.conferenceRecords().transcripts().list(parent=records[0]['name']).execute().get('transcripts', [])
        if not transcripts: return JsonResponse({'success': False, 'error': 'No transcripts found. Google might still be processing them.'}, status=404)
            
        entries = meet.conferenceRecords().transcripts().entries().list(parent=transcripts[0]['name'], pageSize=100).execute().get('transcriptEntries', [])
        if not entries: return JsonResponse({'success': False, 'error': 'Transcript is currently empty. Try again in a few minutes.'}, status=404)
            
        # Parse text
        participant_cache = {}
        lines = []
        for entry in entries:
            p_id = entry.get('participant')
            speaker = 'Unknown'
            if p_id:
                if p_id not in participant_cache:
                    try:
                        p_res = meet.conferenceRecords().participants().get(name=p_id).execute()
                        speaker = p_res.get('signedinUser', {}).get('displayName') or 'Unknown'
                        participant_cache[p_id] = speaker
                    except:
                        participant_cache[p_id] = 'Unknown'
                speaker = participant_cache[p_id]
            lines.append(f"[{speaker}]: {entry.get('text', '')}")
            
        full_text = '\n'.join(lines)
        
        # Save to file
        TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
        file_name = f"Meeting_Transcript_{space_id}.txt"
        file_path = TRANSCRIPTS_DIR / file_name
        
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(full_text)

        return JsonResponse({
            'success': True, 
            'message': 'Transcript downloaded successfully.',
            'file': file_name
        })
        
    except Exception as e:
        print("Error:", e)
        return JsonResponse({'success': False, 'error': str(e)}, status=500)

@csrf_exempt
def harvest_folder(request):
    """Scan the transcripts folder and embed any .txt files not currently in the vector store."""
    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        return JsonResponse({'success': False, 'error': 'GEMINI_API_KEY is missing.'}, status=500)
    
    if not TRANSCRIPTS_DIR.exists():
        return JsonResponse({'success': True, 'message': 'No transcripts folder found.', 'files_processed': 0, 'chunks': 0})
        
    try:
        vector_store = load_vector_store()
        # Find which files are already harvested
        harvested_files = set(item.get('file_name') for item in vector_store if item.get('file_name'))
        
        # We might have old items without 'file_name', let's also check space_id just in case
        # But scanning files is primary
        
        new_files = []
        for file_path in TRANSCRIPTS_DIR.iterdir():
            if file_path.suffix == '.txt' and file_path.name not in harvested_files:
                new_files.append(file_path)
                
        if not new_files:
            return JsonResponse({'success': True, 'message': 'No new files to harvest.', 'files_processed': 0, 'chunks': 0})
            
        client = genai.Client(api_key=api_key)
        total_chunks = 0
        
        for file_path in new_files:
            with open(file_path, 'r', encoding='utf-8') as f:
                full_text = f.read()
                
            chunks = chunk_text(full_text)
            
            # Embed all chunks for this file
            try:
                response = client.models.embed_content(
                    model='gemini-embedding-2',
                    contents=chunks
                )
            except Exception as api_err:
                error_str = str(api_err).lower()
                if "429" in error_str or "quota" in error_str or "exhausted" in error_str:
                    return JsonResponse({'success': False, 'quota_exceeded': True, 'error': 'Quota exceeded.'}, status=429)
                raise api_err
                
            embeddings = [emb.values for emb in response.embeddings]
            
            for chunk, embedding in zip(chunks, embeddings):
                vector_store.append({
                    'file_name': file_path.name,
                    'text': chunk,
                    'vector': embedding
                })
            
            total_chunks += len(chunks)
            
        save_vector_store(vector_store)
        
        return JsonResponse({
            'success': True,
            'message': 'Harvesting complete!',
            'files_processed': len(new_files),
            'files_list': [f.name for f in new_files],
            'chunks': total_chunks
        })

    except Exception as e:
        error_str = str(e).lower()
        if "429" in error_str or "quota" in error_str or "exhausted" in error_str:
            return JsonResponse({'success': False, 'quota_exceeded': True, 'error': 'Quota exceeded.'}, status=429)
        print("Harvest Error:", e)
        return JsonResponse({'success': False, 'error': str(e)}, status=500)

@csrf_exempt
def chat_message(request):
    """Retrieve relevant chunks via vector similarity and generate AI response."""
    try:
        data = json.loads(request.body)
        message = data.get('message')
        chat_id = data.get('chat_id')
    except:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
        
    api_key = os.environ.get('GEMINI_API_KEY')
    if not message or not api_key or not chat_id:
        return JsonResponse({'error': 'Message, chat_id, or API Key missing'}, status=400)

    try:
        client = genai.Client(api_key=api_key)
        
        # 1. Embed the user's question
        q_emb = client.models.embed_content(
            model='gemini-embedding-2',
            contents=message
        ).embeddings[0].values
        
        # 2. Retrieve top chunks using Cosine Similarity
        vector_store = load_vector_store()
        relevant_context = ""
        
        if vector_store:
            q_vec = np.array(q_emb)
            db_vecs = np.array([item['vector'] for item in vector_store])
            
            q_norm = np.linalg.norm(q_vec)
            db_norms = np.linalg.norm(db_vecs, axis=1)
            similarities = np.dot(db_vecs, q_vec) / (db_norms * q_norm)
            
            top_k = 5
            top_indices = np.argsort(similarities)[-top_k:][::-1]
            
            retrieved_chunks = [vector_store[i]['text'] for i in top_indices if similarities[i] > 0.3]
            if retrieved_chunks:
                relevant_context = "Context from past meetings:\n" + "\n---\n".join(retrieved_chunks)
        
        # 3. Load DB and specific Chat History
        chats_db = {}
        if CHATS_DB_FILE.exists():
            with open(CHATS_DB_FILE, 'r', encoding='utf-8') as f:
                try:
                    chats_db = json.load(f)
                except:
                    pass
                    
        if chat_id not in chats_db:
            chats_db[chat_id] = {
                'title': message[:30] + ('...' if len(message) > 30 else ''),
                'updated_at': __import__('time').time(),
                'messages': []
            }
            
        chat_session = chats_db[chat_id]
        history = chat_session['messages']
                
        system_prompt = f"""You are a meeting assistant. Answer the user based ONLY on the provided context from past meetings. 
If the answer is not in the context, say you don't know based on the transcripts.
        
{relevant_context}"""

        conversation = "\n".join([f"{'User' if m['role']=='user' else 'Assistant'}: {m['content']}" for m in history])
        full_prompt = f"{conversation}\nUser: {message}\nAssistant:"

        response = client.models.generate_content(
            model='gemini-3.6-flash',
            contents=full_prompt,
            config=types.GenerateContentConfig(system_instruction=system_prompt)
        )
        
        reply = response.text
        
        history.append({'role': 'user', 'content': message})
        history.append({'role': 'assistant', 'content': reply})
        chat_session['updated_at'] = __import__('time').time()
        
        with open(CHATS_DB_FILE, 'w', encoding='utf-8') as f:
            json.dump(chats_db, f, indent=2)
            
        return JsonResponse({'reply': reply, 'history': history, 'chat_id': chat_id, 'title': chat_session['title']})
    except Exception as e:
        print("Chat Error:", e)
        return JsonResponse({'error': 'AI failed.'}, status=500)

def list_chats(request):
    chats_db = {}
    if CHATS_DB_FILE.exists():
        with open(CHATS_DB_FILE, 'r', encoding='utf-8') as f:
            try:
                chats_db = json.load(f)
            except:
                pass
    
    # Sort by updated_at descending
    sorted_chats = sorted(
        [{'id': k, 'title': v.get('title', 'New Chat'), 'updated_at': v.get('updated_at', 0)} for k, v in chats_db.items()],
        key=lambda x: x['updated_at'],
        reverse=True
    )
    return JsonResponse({'chats': sorted_chats})

def get_chat(request, chat_id):
    if CHATS_DB_FILE.exists():
        with open(CHATS_DB_FILE, 'r', encoding='utf-8') as f:
            try:
                chats_db = json.load(f)
                if chat_id in chats_db:
                    return JsonResponse({'history': chats_db[chat_id]['messages'], 'title': chats_db[chat_id]['title']})
            except:
                pass
    return JsonResponse({'error': 'Chat not found'}, status=404)

@csrf_exempt
def delete_chat(request, chat_id):
    if request.method == 'DELETE':
        if CHATS_DB_FILE.exists():
            with open(CHATS_DB_FILE, 'r', encoding='utf-8') as f:
                try:
                    chats_db = json.load(f)
                except:
                    chats_db = {}
            
            if chat_id in chats_db:
                del chats_db[chat_id]
                with open(CHATS_DB_FILE, 'w', encoding='utf-8') as f:
                    json.dump(chats_db, f, indent=2)
                return JsonResponse({'success': True})
    return JsonResponse({'error': 'Failed to delete'}, status=400)

# --- 4. URL ROUTING ---
urlpatterns = [
    path('auth/login', auth_login),
    path('auth/google/callback', auth_callback),
    path('auth/status', auth_status),
    path('api/meet/transcript', meet_transcript),
    path('api/harvest', harvest_folder),
    path('api/chats/message', chat_message),
    path('api/chats', list_chats),
    path('api/chats/<str:chat_id>', get_chat),
    path('api/chats/<str:chat_id>/delete', delete_chat),
]

# --- 5. RUN SERVER ---
if __name__ == '__main__':
    # Default to runserver on port 5000
    if len(sys.argv) == 1:
        sys.argv += ['runserver', '5000']
    execute_from_command_line(sys.argv)
