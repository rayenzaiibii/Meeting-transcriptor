'use client';

import { useState, useEffect, useRef } from 'react';
import './App.css';

export default function MeetingTranscriber() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    
    // Meet URL State
    const [meetingInput, setMeetingInput] = useState('');
    const [isFetchingMeet, setIsFetchingMeet] = useState(false);
    
    // Chat State
    const [chats, setChats] = useState([]);
    const [activeChatId, setActiveChatId] = useState(null);
    const [chatInput, setChatInput] = useState('');
    const [chatHistory, setChatHistory] = useState([]);
    const [isChatting, setIsChatting] = useState(false);
    
    // UI State
    const [status, setStatus] = useState(null);
    const messagesEndRef = useRef(null);

    // Initial Auth & History Check
    useEffect(() => {
        fetch('http://localhost:5000/auth/status')
            .then((res) => res.json())
            .then((data) => {
                if (data.authenticated) {
                    setIsAuthenticated(true);
                    loadChats();
                }
            })
            .catch((err) => console.error('Backend not running on port 5000', err));
    }, []);

    const loadChats = async () => {
        try {
            const res = await fetch('http://localhost:5000/api/chats');
            const data = await res.json();
            if (data.chats) setChats(data.chats);
        } catch (e) {
            console.error("Could not load chats");
        }
    };

    const handleSelectChat = async (chatId) => {
        setActiveChatId(chatId);
        try {
            const res = await fetch(`http://localhost:5000/api/chats/${chatId}`);
            const data = await res.json();
            if (data.history) setChatHistory(data.history);
        } catch (e) {
            console.error("Could not load chat history");
        }
    };

    const handleNewChat = () => {
        setActiveChatId(null);
        setChatHistory([]);
    };

    const handleDeleteChat = async (e, chatId) => {
        e.stopPropagation(); // prevent selecting the chat
        if (!window.confirm("Are you sure you want to delete this chat?")) return;
        
        try {
            await fetch(`http://localhost:5000/api/chats/${chatId}/delete`, { method: 'DELETE' });
            if (activeChatId === chatId) {
                handleNewChat();
            }
            loadChats();
        } catch (err) {
            showToast('Failed to delete chat.');
        }
    };

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [chatHistory]);

    const handleLogin = () => {
        window.location.href = 'http://localhost:5000/auth/login';
    };

    const showToast = (message) => {
        setStatus(message);
        setTimeout(() => setStatus(null), 4000);
    };

    // Harvest Log State
    const [harvestLog, setHarvestLog] = useState([]);
    const [quotaWaitTime, setQuotaWaitTime] = useState(0);

    const addLog = (type, message) => {
        setHarvestLog([{ id: Date.now(), type, message, time: new Date().toLocaleTimeString() }]);
    };

    // Auto-retry countdown effect
    useEffect(() => {
        let timer;
        if (quotaWaitTime > 0) {
            timer = setInterval(() => {
                setQuotaWaitTime(prev => {
                    if (prev <= 1) {
                        clearInterval(timer);
                        addLog('info', 'Retrying harvest automatically...');
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
        } else if (quotaWaitTime === 0 && harvestLog.length > 0 && harvestLog[harvestLog.length-1].type === 'yellow') {
            handleHarvestFolder();
        }
        return () => clearInterval(timer);
    }, [quotaWaitTime]);

    const handleSaveTranscript = async () => {
        const match = meetingInput.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
        const spaceId = match ? match[1] : null;

        if (!spaceId) {
            addLog('red', 'Invalid Meet code.');
            return;
        }

        setIsFetchingMeet(true);
        addLog('info', `Downloading transcript for ${spaceId} from Google Meet...`);

        try {
            const response = await fetch(`http://localhost:5000/api/meet/transcript?spaceId=${spaceId}`);
            const data = await response.json();
            
            if (data.success) {
                addLog('green', `Success: ${data.file} downloaded to your transcripts folder!`);
                setMeetingInput('');
            } else {
                addLog('red', data.error || 'Failed to download transcript.');
            }
        } catch (error) {
            addLog('red', 'Network error connecting to backend.');
        } finally {
            setIsFetchingMeet(false);
        }
    };

    const handleHarvestFolder = async () => {
        addLog('info', 'Scanning folder for new transcripts...');
        try {
            const response = await fetch('http://localhost:5000/api/harvest');
            const data = await response.json();
            
            if (response.status === 429 || data.quota_exceeded) {
                addLog('yellow', 'Quota exceeded. Waiting for 5 minutes to continue...');
                setQuotaWaitTime(300);
            } else if (data.success) {
                if (data.files_processed === 0) {
                    addLog('info', data.message);
                } else {
                    addLog('green', `Success: Processed ${data.files_processed} new file(s) and sent ${data.chunks} chunks to vector store.`);
                }
            } else {
                addLog('red', data.error || 'Failed to harvest folder.');
            }
        } catch (error) {
            addLog('red', 'Network error connecting to backend.');
        }
    };

    const handleSendMessage = async (e) => {
        if (e) e.preventDefault();
        if (!chatInput.trim()) return;

        const userMessage = chatInput.trim();
        setChatInput('');
        setIsChatting(true);
        
        const newHistory = [...chatHistory, { role: 'user', content: userMessage }];
        setChatHistory(newHistory);
        
        const currentChatId = activeChatId || Date.now().toString();
        const isNewChat = !activeChatId;
        
        if (isNewChat) {
            setActiveChatId(currentChatId);
        }

        try {
            const response = await fetch('http://localhost:5000/api/chats/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userMessage, chat_id: currentChatId })
            });
            const data = await response.json();
            
            if (data.error) {
                showToast(data.error);
            } else if (data.reply) {
                setChatHistory([...newHistory, { role: 'assistant', content: data.reply }]);
                if (isNewChat) {
                    loadChats(); // Refresh list to show the new chat title
                }
            }
        } catch (error) {
            showToast('Failed to reach AI server.');
        } finally {
            setIsChatting(false);
        }
    };

    const handleHarvestNavClick = () => {
        handleHarvestFolder();
    };

    if (!isAuthenticated) {
        return (
            <div className="auth-container">
                <div className="auth-card">
                    <h2>Meeting Assistant</h2>
                    <p style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '24px' }}>
                        Sign in to harvest transcripts and chat with your meeting data.
                    </p>
                    <button className="primary-button" onClick={handleLogin}>
                        Sign in with Google
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="app-container">
            {status && <div className="status-toast">{status}</div>}
            
            {/* Left Sidebar */}
            <aside className="sidebar">
                <div className="sidebar-header">
                    <h2>Meeting Assistant</h2>
                </div>
                
                <div className="sidebar-history">
                    <div className="history-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        Chat History
                        <button className="new-chat-btn" onClick={handleNewChat} title="New Chat">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        </button>
                    </div>
                    
                    <button className={`history-item ${!activeChatId ? 'active' : ''}`} onClick={handleNewChat}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                        New Chat
                    </button>
                    
                    {chats.map(chat => (
                        <button key={chat.id} className={`history-item ${activeChatId === chat.id ? 'active' : ''}`} onClick={() => handleSelectChat(chat.id)}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                            <span className="chat-title">{chat.title}</span>
                            <div className="delete-chat" onClick={(e) => handleDeleteChat(e, chat.id)}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            </div>
                        </button>
                    ))}
                </div>

                <div className="sidebar-footer">
                    {/* Harvest Log Panel */}
                    <div className="harvest-log-panel">
                        <div className="history-label" style={{ padding: '0' }}>Harvest Logs</div>
                        <div className="log-entries">
                            {harvestLog.length === 0 && <div className="log-empty">Ready to harvest...</div>}
                            {harvestLog.map(log => (
                                <div key={log.id} className={`log-entry log-${log.type}`}>
                                    <span className="log-time">{log.time}</span>
                                    <span>{log.message}</span>
                                    {log.type === 'yellow' && quotaWaitTime > 0 && (
                                        <div className="log-timer">
                                            Retrying in {Math.floor(quotaWaitTime / 60)}:{(quotaWaitTime % 60).toString().padStart(2, '0')}...
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="meet-input-wrapper">
                        <input
                            id="harvest-input"
                            type="text"
                            placeholder="Meet code (abc-xyz)"
                            value={meetingInput}
                            onChange={(e) => setMeetingInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscript()}
                            disabled={quotaWaitTime > 0}
                        />
                        <button onClick={handleSaveTranscript} disabled={isFetchingMeet || quotaWaitTime > 0}>
                            {isFetchingMeet ? '...' : 'Add'}
                        </button>
                    </div>
                </div>
            </aside>

            {/* Main Chat Content */}
            <main className="main-content">
                {/* Top Nav (Right side only) */}
                <nav className="top-nav">
                    <div className="nav-actions">
                        <button className="nav-btn" onClick={handleHarvestNavClick}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            Harvest
                        </button>
                    </div>
                </nav>

                <div className="chat-area">
                    {chatHistory.length === 0 ? (
                        <div className="welcome-screen">
                            <div className="sparkle-icon">✨</div>
                            <h1>Hello, how can I help?</h1>
                            <p>Ask questions about your harvested meeting transcripts and more.</p>
                        </div>
                    ) : (
                        <div className="chat-history">
                            {chatHistory.map((msg, index) => (
                                <div key={index} className={`chat-message ${msg.role}`}>
                                    <div className="message-bubble">
                                        {msg.content}
                                    </div>
                                </div>
                            ))}
                            {isChatting && (
                                <div className="chat-message assistant">
                                    <div className="message-bubble" style={{ color: 'rgba(255,255,255,0.5)' }}>
                                        Thinking...
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>
                    )}
                </div>

                {/* Bottom Bar */}
                <div className="bottom-bar">
                    <form className="chat-input-center" onSubmit={handleSendMessage}>
                        <input
                            type="text"
                            placeholder="Ask about your meetings..."
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            disabled={isChatting}
                        />
                        <button 
                            type="submit" 
                            className="send-button"
                            disabled={!chatInput.trim() || isChatting}
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                        </button>
                    </form>
                </div>
            </main>
        </div>
    );
}