// frontend/src/App.jsx
import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Auth from './components/Auth';
import Dashboard from './components/Dashboard';
import ChatRoom from './components/ChatRoom';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'https://single-backend-giuf.onrender.com';

const socket = io(SOCKET_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling']
});

export default function App() {
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState({ gender: 'Male' });
  const [status, setStatus] = useState('idle');
  const [chatmateInfo, setChatmateInfo] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const searchTimeoutRef = useRef(null);

  // PWA Install Prompt State
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);

  useEffect(() => {
    // Listen for browser PWA Install Event
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setIsInstallable(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // Socket Event Listeners
    socket.on('connect', () => {
      console.log('Connected to Render socket server:', socket.id);
    });

    socket.on('queue_status', () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      searchTimeoutRef.current = window.setTimeout(() => {
        setStatus('idle');
        setRoomId(null);
        setChatmateInfo(null);
      }, 20000);
      setStatus('searching');
    });

    socket.on('chat_matched', ({ roomId, partnerInfo }) => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      setRoomId(roomId);
      setChatmateInfo(partnerInfo);
      setStatus('matched');
    });

    socket.on('queue_timeout', () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      setStatus('idle');
      setRoomId(null);
      setChatmateInfo(null);
    });

    socket.on('partner_left', () => setStatus('partner_disconnected'));

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      socket.off('connect');
      socket.off('queue_status');
      socket.off('chat_matched');
      socket.off('queue_timeout');
      socket.off('partner_left');
    };
  }, []);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setIsInstallable(false);
      }
      setDeferredPrompt(null);
    } else {
      alert(
        "To install SINGLE on your device:\n\n" +
        "• Desktop (Chrome/Edge): Click the 'Install App' icon on the right side of your address bar.\n" +
        "• Android (Chrome): Tap the menu (⋮) -> 'Add to Home screen' / 'Install App'.\n" +
        "• iOS (Safari): Tap the Share button -> 'Add to Home Screen'."
      );
    }
  };

  const handleAuthSuccess = (sessionUser) => {
    setUser(sessionUser);
    if (!socket.connected) {
      socket.connect();
    }
  };

  const startSearching = (filterGender) => {
    if (!socket.connected) {
      socket.connect();
    }
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    setStatus('searching');
    socket.emit('find_chatmate', {
      nickname: user?.name || 'Anonymous',
      gender: userProfile.gender,
      filterGender: filterGender || 'Any'
    });
  };

  const leaveChat = () => {
    socket.emit('leave_chat');
    setStatus('idle');
    setRoomId(null);
    setChatmateInfo(null);
  };

  if (!user) return <Auth onAuthSuccess={handleAuthSuccess} />;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between font-sans">
      {/* Header Bar */}
      <header className="p-4 border-b border-slate-800/80 flex justify-between items-center bg-slate-900/60 backdrop-blur-md">
        {/* Logo & Branding */}
        <div className="flex items-center gap-2.5">
          <img 
            src="/secret.png" 
            alt="SINGLE Logo" 
            className="w-8 h-8 object-contain drop-shadow-[0_4px_12px_rgba(244,63,94,0.3)]"
          />
          <h1 className="text-xl font-black tracking-widest bg-gradient-to-r from-pink-500 via-rose-400 to-indigo-400 bg-clip-text text-transparent uppercase">
            SINGLE
          </h1>
        </div>

        {/* Right Header Controls */}
        <div className="flex items-center gap-3">
          {/* PWA Install Button */}
          <button
            onClick={handleInstallClick}
            className="flex items-center gap-1.5 bg-gradient-to-r from-rose-600 to-pink-500 hover:from-rose-500 hover:to-pink-400 text-white font-bold text-xs px-3 py-1.5 rounded-full shadow-lg shadow-rose-600/20 active:scale-95 transition-all duration-200 cursor-pointer"
            title="Install App"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span className="hidden sm:inline">Install App</span>
          </button>

          {/* User Nickname Badge */}
          <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-800 px-3.5 py-1.5 rounded-full shadow-inner">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            <span className="text-xs text-slate-300 font-bold">{user?.name || 'User'}</span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col justify-center items-center p-4">
        {status === 'idle' || status === 'searching' ? (
          <Dashboard
            status={status}
            userProfile={userProfile}
            setUserProfile={setUserProfile}
            onStart={startSearching}
          />
        ) : (
          <ChatRoom
            socket={socket}
            roomId={roomId}
            chatmateInfo={chatmateInfo}
            status={status}
            onSkip={() => { socket.emit('leave_chat'); startSearching('Any'); }}
            onLeave={leaveChat}
          />
        )}
      </main>
    </div>
  );
}