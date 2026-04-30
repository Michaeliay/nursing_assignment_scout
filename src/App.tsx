import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Search, 
  Send, 
  Settings as SettingsIcon, 
  History, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle,
  Loader2,
  Mail,
  Zap,
  LogIn,
  LogOut,
  User as UserIcon
} from 'lucide-react';
import { db, auth, OperationType, handleFirestoreError, signInWithPopup, googleProvider, signOut } from './lib/firebase';
import { collection, query, orderBy, limit, onSnapshot, addDoc, serverTimestamp, setDoc, doc, getDoc, where } from 'firebase/firestore';
import { searchAIProducts, summarizeDigest } from './services/geminiService';
import Markdown from 'react-markdown';
import { User } from 'firebase/auth';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [digests, setDigests] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isScouting, setIsScouting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [email, setEmail] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [status, setStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    const unsubscribeAuth = auth.onAuthStateChanged(async (u) => {
      setUser(u);
      if (u) {
        setEmail(u.email || '');
        // Fetch settings
        try {
          const settingsDoc = await getDoc(doc(db, 'settings', u.uid));
          if (settingsDoc.exists()) {
            const data = settingsDoc.data();
            if (data.email) setEmail(data.email);
            if (data.searchQuery) setSearchQuery(data.searchQuery);
          }
        } catch (e) {
          console.error("Error fetching settings", e);
        }
      } else {
        setDigests([]);
      }
      setIsLoading(false);
    });

    return () => unsubscribeAuth();
  }, []);

  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'digests'), 
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc'), 
      limit(10)
    );

    const unsubscribe = onSnapshot(q, 
      (snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setDigests(data);
      },
      (error) => {
        // Only report if it's a real operational error when logged in
        if (auth.currentUser) {
          handleFirestoreError(error, OperationType.LIST, 'digests');
        }
      }
    );

    return () => unsubscribe();
  }, [user]);

  const login = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      if (error?.code !== 'auth/cancelled-popup-request') {
        console.error("Login failed", error);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const logout = () => signOut(auth);

  const saveSettings = async () => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'settings', user.uid), {
        email: email,
        searchQuery: searchQuery,
        userId: user.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
      setStatus({ type: 'success', message: 'Settings saved successfully' });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `settings/${user.uid}`);
    }
  };

  const runScout = async () => {
    if (!user) return;
    setIsScouting(true);
    setStatus(null);
    try {
      const previouslySeen = Array.from(new Set(digests.flatMap(d => [
        ...(d.newProducts || []).map((p: any) => p.title),
        ...(d.existingProducts || []).map((p: any) => p.title),
        ...(d.links || []).map((l: any) => l.title) // Support legacy links field
      ])));

      const rawResults = await searchAIProducts(searchQuery);
      const digestData = await summarizeDigest(rawResults || '', previouslySeen);
      
      const docRef = await addDoc(collection(db, 'digests'), {
        userId: user.uid,
        summary: digestData.summary || "Summary pending...",
        newProducts: digestData.newProducts || [],
        existingProducts: digestData.existingProducts || [],
        createdAt: serverTimestamp(),
        status: 'pending'
      });

      // Send email if configured
      const targetEmail = email || user.email;
      if (targetEmail) {
        try {
          await fetch('/api/send-digest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: targetEmail,
              subject: `Weekly AI Scout: Nurse Zone Automation (${new Date().toLocaleDateString()})`,
              html: `
                <div style="font-family: sans-serif; color: #141414; line-height: 1.6;">
                  <h1 style="border-bottom: 2px solid #141414; padding-bottom: 10px;">Weekly AI Scout Digest</h1>
                  <div style="margin: 20px 0;">
                    ${digestData.summary.replace(/\n/g, '<br/>')}
                  </div>
                  
                  ${digestData.newProducts.length > 0 ? `
                    <h3 style="text-transform: uppercase; color: #166534;">★ New Discoveries:</h3>
                    <div style="margin-bottom: 20px;">
                      ${digestData.newProducts.map((p: any) => `
                        <div style="margin-bottom: 15px; padding: 12px; border: 1px solid #166534; background: #f0fdf4;">
                          <a href="${p.url}" style="color: #141414; font-weight: bold; text-decoration: none; font-size: 16px;">${p.title} &rarr;</a>
                          <p style="margin: 5px 0 0 0; font-size: 14px; color: #374151;">${p.description || ''}</p>
                        </div>
                      `).join('')}
                    </div>
                  ` : ''}

                  ${digestData.existingProducts.length > 0 ? `
                    <h3 style="text-transform: uppercase; opacity: 0.7;">Previously Noted:</h3>
                    <ul style="list-style: none; padding: 0;">
                      ${digestData.existingProducts.map((p: any) => `
                        <li style="margin-bottom: 8px; padding: 8px; border: 1px solid #eee;">
                          <a href="${p.url}" style="color: #6b7280; text-decoration: none; font-size: 14px;">${p.title}</a>
                        </li>
                      `).join('')}
                    </ul>
                  ` : ''}
                </div>
              `
            })
          });
          
          await setDoc(doc(db, 'digests', docRef.id), { status: 'sent' }, { merge: true });
          setStatus({ type: 'success', message: 'Scout complete! Digest sent to ' + targetEmail });
        } catch (e) {
          console.error("Email failed", e);
          await setDoc(doc(db, 'digests', docRef.id), { status: 'failed' }, { merge: true });
          setStatus({ type: 'error', message: 'Scout complete, but email failed to send.' });
        }
      } else {
        await setDoc(doc(db, 'digests', docRef.id), { status: 'pending' }, { merge: true });
        setStatus({ type: 'success', message: 'Scout complete! (Configure email to receive digests)' });
      }

    } catch (error) {
      console.error(error);
      setStatus({ type: 'error', message: 'Scout failed. Please try again.' });
    } finally {
      setIsScouting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#E4E3E0] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin opacity-20" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-[#141414] p-12 text-center">
          <Zap className="w-12 h-12 fill-[#141414] mx-auto mb-6" />
          <h1 className="text-3xl font-bold uppercase tracking-tighter mb-4">NurseZone AI Scout</h1>
          <p className="text-sm opacity-60 mb-8 leading-relaxed">
            Your intelligence agent for AI nursing zone automation. Sign in with your Google account to start your daily scout.
          </p>
          <button 
            onClick={login}
            className="w-full flex items-center justify-center gap-3 bg-[#141414] text-[#E4E3E0] px-6 py-3 uppercase text-xs font-bold tracking-widest hover:bg-opacity-90 transition-all"
          >
            <LogIn className="w-4 h-4" />
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans">
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center bg-[#E4E3E0] sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Zap className="w-6 h-6 fill-[#141414]" />
          <h1 className="text-xl font-bold uppercase tracking-tight">NurseZone AI Scout</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 pr-4 border-r border-[#141414]">
            <div className="text-[10px] uppercase font-bold text-right">
              <div className="opacity-40 leading-none">Logged in as</div>
              <div className="leading-none mt-1 truncate max-w-[120px]">{user?.displayName || user?.email}</div>
            </div>
            <div className="w-8 h-8 rounded-full bg-[#141414] text-[#E4E3E0] flex items-center justify-center overflow-hidden">
              {user?.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : <UserIcon className="w-4 h-4" />}
            </div>
          </div>
          <button 
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 hover:bg-[#141414] hover:text-[#E4E3E0] transition-colors"
          >
            <SettingsIcon className="w-5 h-5" />
          </button>
          <button 
            onClick={logout}
            className="p-2 hover:bg-[#141414] hover:text-[#E4E3E0] transition-colors"
            title="Logout"
          >
            <LogOut className="w-5 h-5" />
          </button>
          <button 
            onClick={runScout}
            disabled={isScouting}
            className="flex items-center gap-2 bg-[#141414] text-[#E4E3E0] px-6 py-2 uppercase text-xs font-bold tracking-widest hover:bg-opacity-90 disabled:opacity-50"
          >
            {isScouting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {isScouting ? 'Scouting...' : 'Trigger Scout'}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Settings Panel Sidebar */}
        <AnimatePresence>
          {showSettings && (
            <motion.div 
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="lg:col-span-3 border border-[#141414] p-6 bg-white/50 backdrop-blur-sm self-start"
            >
              <h2 className="font-serif italic text-xs uppercase opacity-50 mb-4 tracking-widest">Preferences</h2>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] uppercase font-bold tracking-wider mb-1 block">Digest Email</label>
                  <input 
                    type="email" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="w-full bg-transparent border-b border-[#141414] py-1 text-sm focus:outline-none placeholder:opacity-30 mb-4"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold tracking-wider mb-1 block">Additional Search Parameters</label>
                  <textarea 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="e.g. mobile apps, specific hospitals, or vendor names..."
                    rows={3}
                    className="w-full bg-transparent border border-[#141414] p-2 text-sm focus:outline-none placeholder:opacity-30 resize-none"
                  />
                  <p className="text-[9px] opacity-40 mt-1">These parameters will be added to the default nursing zone automation search.</p>
                </div>
                <button 
                  onClick={saveSettings}
                  className="w-full bg-[#141414] text-[#E4E3E0] py-2 uppercase text-[10px] font-bold tracking-widest hover:bg-opacity-80 transition-all mt-2"
                >
                  Save Settings
                </button>
                <div className="pt-4 border-t border-[#141414]/10">
                  <div className="flex items-center gap-2 text-[10px] uppercase font-bold tracking-wider mb-2">
                    <History className="w-3 h-3" />
                    Frequency
                  </div>
                  <p className="text-xs opacity-70">Weekly automated scout is active. System searches every Monday at 8:00 AM UTC.</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Content Area */}
        <div className={`${showSettings ? 'lg:col-span-9' : 'lg:col-span-12'} space-y-8`}>
          
          {/* Status Message */}
          {status && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`p-4 border flex items-center gap-3 ${status.type === 'success' ? 'border-green-800 bg-green-50 text-green-900' : 'border-red-800 bg-red-50 text-red-900'}`}
            >
              {status.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
              <span className="text-sm font-medium">{status.message}</span>
            </motion.div>
          )}

          {/* Latest Digest */}
          {digests.length > 0 ? (
            <div className="space-y-12">
              {digests.map((digest, idx) => (
                <section key={digest.id} className={`${idx === 0 ? 'bg-white p-8 lg:p-12 border border-[#141414]' : 'opacity-60 hover:opacity-100 transition-opacity'}`}>
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                    <div>
                      <span className="font-serif italic text-xs uppercase opacity-50 tracking-widest block mb-1">
                        {new Date(digest.createdAt?.toDate?.() || Date.now()).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                      </span>
                      <h2 className="text-3xl font-bold tracking-tighter uppercase leading-none">
                        {idx === 0 ? 'Latest Intelligence' : `Scout Report #${digests.length - idx}`}
                      </h2>
                    </div>
                    <div className="flex items-center gap-3">
                      {digest.status === 'sent' && <div className="flex items-center gap-1 text-[10px] font-bold text-green-800 border border-green-800 px-2 py-0.5 rounded-full uppercase">Sent <Mail className="w-3 h-3" /></div>}
                      {digest.status === 'failed' && <div className="flex items-center gap-1 text-[10px] font-bold text-red-800 border border-red-800 px-2 py-0.5 rounded-full uppercase">Failed <AlertCircle className="w-3 h-3" /></div>}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                    <div className="prose prose-sm prose-stone max-w-none">
                      <div className="font-mono text-xs uppercase opacity-30 mb-4 tracking-widest border-b border-[#141414] pb-1">Report Summary</div>
                      <div className="text-[#141414] leading-relaxed markdown-content">
                        <Markdown>
                          {digest.summary}
                        </Markdown>
                      </div>
                    </div>

                    <div className="space-y-10">
                      <div>
                        <div className="font-mono text-xs uppercase opacity-30 mb-4 tracking-widest border-b border-[#141414] pb-1 flex justify-between items-center">
                          <span>New Discoveries</span>
                          <span className="text-[8px] bg-[#141414] text-[#E4E3E0] px-1.5 py-0.5 rounded-full">★</span>
                        </div>
                        <div className="grid gap-4">
                          {(digest.newProducts || []).map((p: any, i: number) => (
                            <div key={i} className="group border border-[#141414] p-5 bg-white hover:bg-[#141414] hover:text-[#E4E3E0] transition-all">
                              <a 
                                href={p.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="block mb-2"
                              >
                                <div className="flex justify-between items-center">
                                  <span className="font-bold uppercase text-base tracking-tight">{p.title}</span>
                                  <ArrowRight className="w-4 h-4 transform group-hover:translate-x-1 transition-transform" />
                                </div>
                              </a>
                              <p className="text-xs leading-relaxed opacity-70 group-hover:opacity-100">
                                {p.description}
                              </p>
                            </div>
                          ))}
                          {(!digest.newProducts || digest.newProducts.length === 0) && (
                            <p className="text-[10px] uppercase font-bold opacity-30 italic">No new products identified in this cycle.</p>
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="font-mono text-xs uppercase opacity-30 mb-4 tracking-widest border-b border-[#141414] pb-1">Previously Noted</div>
                        <div className="grid gap-2">
                          {(digest.existingProducts || []).map((p: any, i: number) => (
                            <a 
                              key={i} 
                              href={p.url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="group flex justify-between items-center p-3 border border-dashed border-[#141414]/20 hover:border-[#141414] hover:bg-[#141414]/5 transition-all opacity-70 hover:opacity-100"
                            >
                              <span className="font-bold uppercase text-xs tracking-tight">{p.title}</span>
                              <ArrowRight className="w-3 h-3 transform group-hover:translate-x-1 transition-transform" />
                            </a>
                          ))}
                          {/* Legacy Support */}
                          {digest.links?.map((link: any, i: number) => (
                            <a 
                              key={`legacy-${i}`} 
                              href={link.url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="group flex justify-between items-center p-3 border border-dashed border-[#141414]/20 hover:border-[#141414] hover:bg-[#141414]/5 transition-all opacity-70 hover:opacity-100"
                            >
                              <span className="font-bold uppercase text-xs tracking-tight">{link.title}</span>
                              <ArrowRight className="w-3 h-3 transform group-hover:translate-x-1 transition-transform" />
                            </a>
                          ))}
                          {(!digest.existingProducts || (digest.existingProducts.length === 0 && (!digest.links || digest.links.length === 0))) && (
                            <p className="text-[10px] uppercase font-bold opacity-30 italic">No historical references included.</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="h-96 flex flex-col items-center justify-center border border-dashed border-[#141414] opacity-30">
              <History className="w-12 h-12 mb-4" />
              <p className="uppercase text-xs font-bold tracking-widest">No scout reports generated yet.</p>
              <button 
                onClick={runScout}
                className="mt-4 underline text-xs font-bold uppercase tracking-widest"
              >
                Scan industry now
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Footer Info */}
      <footer className="mt-20 border-t border-[#141414] p-8 flex flex-col md:flex-row justify-between items-center gap-4 bg-white/50 text-[10px] uppercase font-bold tracking-[0.2em] opacity-40">
        <div>NurseZone AI Scout © 2026</div>
        <div className="flex gap-8">
          <span>Sourcing: Gemini 3.1 & Google Search</span>
          <span>Security: Firebase Hardened</span>
        </div>
      </footer>
    </div>
  );
}
