/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { GoogleGenAI } from "@google/genai";
import { 
  Mic, 
  Square, 
  Upload, 
  TrendingUp, 
  AlertCircle, 
  CheckCircle2, 
  History, 
  Loader2,
  Volume2,
  LogOut,
  User as UserIcon,
  ShieldCheck,
  Zap,
  BarChart3,
  Lock
} from "lucide-react";
import { useDropzone } from "react-dropzone";
import WaveSurfer from "wavesurfer.js";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Firebase imports
import { auth, db, googleProvider } from "./firebase";
import { 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  User as FirebaseUser 
} from "firebase/auth";
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  limit, 
  getDocs,
  Timestamp,
  doc,
  setDoc,
  getDoc
} from "firebase/firestore";

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const getAvatarColor = (uid: string) => {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = uid.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
  return "#" + "00000".substring(0, 6 - c.length) + c;
};

// --- Components ---
const AnimatedWaveform = () => (
  <svg width="120" height="40" viewBox="0 0 120 40" className="text-gold-500">
    {[...Array(12)].map((_, i) => (
      <motion.rect
        key={i}
        x={i * 10}
        y="20"
        width="4"
        height="4"
        rx="2"
        animate={{ 
          height: [4, 32, 4],
          y: [18, 4, 18]
        }}
        transition={{ 
          repeat: Infinity, 
          duration: 0.6, 
          delay: i * 0.05,
          ease: "easeInOut"
        }}
        fill="currentColor"
      />
    ))}
  </svg>
);

// --- Types ---
interface TransactionDetails {
  item: string;
  quantity: string;
  total_value: number;
  amount_paid: number;
  debt: number;
}

interface CreditInsight {
  trust_score_out_of_100: number;
  risk_reasoning: string;
}

interface ProfileHeader {
  avatar_color: string;
  security_badge: string;
  last_sync: string;
}

interface FutureProjections {
  next_7_days_prediction: number;
  loan_readiness_meter: number;
}

interface UiManifest {
  theme_color: string;
  hero_metric: string | number;
  sheng_summary: string;
  profile_header: ProfileHeader;
}

interface SautiLedgerResponse {
  transaction_details: TransactionDetails;
  credit_insight: CreditInsight;
  ui_manifest: UiManifest;
  data_privacy_flag: boolean;
  future_projections: FutureProjections;
}

interface FirestoreLedgerEntry extends SautiLedgerResponse {
  uid: string;
  timestamp: Timestamp;
}

// --- Constants ---
const LANGUAGES = [
  { id: "en", label: "English", flag: "🇬🇧" },
  { id: "sw", label: "Kiswahili", flag: "🇰🇪" },
  { id: "sheng", label: "Sheng", flag: "🔥" },
  { id: "local", label: "Local Dialects", flag: "🌍" },
];

const SYSTEM_INSTRUCTION = `
You are the "Sauti-Ledger Engine," a specialized financial auditor for the Kenyan informal economy.
Your mission is to process audio clips of market transactions (Mama Mboga, Boda Boda, Hawkers) and extract structured financial data.
You are an expert in English, Swahili, and Sheng.

IDENTITY-BASED REASONING:
- You will be provided with the user's UID, Name, and Selected Languages.
- Personalize all Sheng summaries using their name (e.g., "Sawa, Mama Njeri! Leo umeuza...").
- You will be provided with their 30-day average revenue. Compare current audio data against this average to detect growth or decline in the summary.
- TRANSCRIPTION WEIGHT: Prioritize the user's selected languages when transcribing. If English+Sheng is selected, expect a mix of both.
- INITIAL TRUST FOUNDATION: For every new user (UID), generate an 'Initial Trust Foundation' score based on their first 3 audio transactions. If this is one of their first 3 transactions, explain how this contributes to their foundation in the 'risk_reasoning'.

SECURITY & PRIVACY PROTOCOL:
- Ensure the JSON output includes a 'data_privacy_flag' (boolean).
- If the audio mentions sensitive personal info (like a PIN or home address), omit it from the 'transaction_details' and set 'data_privacy_flag' to true.

AUTHENTICATED UI ELEMENTS:
- Include a 'profile_header' in the ui_manifest:
  - "avatar_color": A unique hex code generated from their UID.
  - "security_badge": "Verified by Sauti-Ledger" (Assume Phone Auth is active if provided).
  - "last_sync": Current timestamp in Nairobi/East Africa format (e.g., "26 Mar 2026, 18:22 EAT").

PREDICTIVE GROWTH:
- Add a field called "future_projections" to the JSON:
  - "next_7_days_prediction": Estimate KES revenue for the next 7 days based on this transaction and the provided historical context.
  - "loan_readiness_meter": A percentage (0-100%) showing how close they are to qualifying for a formal micro-loan based on their ledger consistency.

DOMAIN KNOWLEDGE:
- Convert Sheng/Slang to KES: "Mbao" = 20, "Chuani" = 50, "So" = 100, "Punch/Thao" = 1000, "Mbeti" = 1000.
- Recognize Business Terms: "Deni" (Debt), "Mali" (Inventory), "Baki" (Balance).

OUTPUT REQUIREMENTS (STRICT JSON):
Respond ONLY in JSON format. Do not include any conversational filler.
The JSON must include:
1. "transaction_details": {item, quantity, total_value, amount_paid, debt}
2. "credit_insight": {trust_score_out_of_100, risk_reasoning}
3. "ui_manifest": { theme_color, hero_metric, sheng_summary, profile_header }
4. "data_privacy_flag": boolean
5. "future_projections": { next_7_days_prediction, loan_readiness_meter }

CRITICAL INSTRUCTION:
If the audio includes a verbal agreement for a future payment, calculate the "debt" field and flag it in the credit_insight.
`;

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [onboardingStep, setOnboardingStep] = useState(0); // 0: Auth, 1: Language, 2: Dashboard
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<SautiLedgerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<FirestoreLedgerEntry[]>([]);
  const [avgRevenue, setAvgRevenue] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
      if (currentUser) {
        const userRef = doc(db, "users", currentUser.uid);
        const userDoc = await getDoc(userRef);
        
        if (userDoc.exists()) {
          const data = userDoc.data();
          if (data.languages && data.languages.length > 0) {
            setSelectedLanguages(data.languages);
            setOnboardingStep(2); // Skip to dashboard
          } else {
            setOnboardingStep(1); // Go to language selection
          }
        } else {
          setOnboardingStep(1); // New user, go to language selection
          await setDoc(userRef, {
            uid: currentUser.uid,
            displayName: currentUser.displayName,
            email: currentUser.email,
            phoneNumber: currentUser.phoneNumber,
            lastLogin: Timestamp.now()
          }, { merge: true });
        }
      } else {
        setOnboardingStep(0);
      }
    });
    return () => unsubscribe();
  }, []);

  // Firestore History Listener
  useEffect(() => {
    if (!user || onboardingStep !== 2) {
      setHistory([]);
      return;
    }

    const q = query(
      collection(db, "users", user.uid, "ledger"),
      orderBy("timestamp", "desc"),
      limit(20)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id
      })) as unknown as FirestoreLedgerEntry[];
      setHistory(entries);

      if (entries.length > 0) {
        const total = entries.reduce((acc, curr) => acc + curr.transaction_details.total_value, 0);
        setAvgRevenue(Math.round(total / entries.length));
      }
    }, (err) => {
      console.error("Firestore Error:", err);
      setError("Failed to load ledger history.");
    });

    return () => unsubscribe();
  }, [user, onboardingStep]);

  // Initialize WaveSurfer
  useEffect(() => {
    if (waveformRef.current && audioBlob) {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
      }
      wavesurferRef.current = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: "rgba(255, 255, 255, 0.2)",
        progressColor: "#C5A059",
        cursorColor: "#C5A059",
        barWidth: 3,
        barRadius: 4,
        height: 80,
      });
      wavesurferRef.current.loadBlob(audioBlob);
    }
  }, [audioBlob]);

  // Auth Actions
  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError("Login failed. Please try again.");
      console.error(err);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setResult(null);
      setSelectedLanguages([]);
      setOnboardingStep(0);
    } catch (err) {
      console.error(err);
    }
  };

  const saveLanguages = async () => {
    if (!user || selectedLanguages.length === 0) return;
    try {
      const userRef = doc(db, "users", user.uid);
      await setDoc(userRef, { languages: selectedLanguages }, { merge: true });
      setOnboardingStep(2);
    } catch (err) {
      console.error(err);
      setError("Failed to save preferences.");
    }
  };

  const toggleLanguage = (id: string) => {
    setSelectedLanguages(prev => 
      prev.includes(id) ? prev.filter(l => l !== id) : [...prev, id]
    );
  };

  // Dropzone Logic
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setAudioBlob(acceptedFiles[0]);
      setError(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 
      "audio/mpeg": [".mp3"], 
      "audio/wav": [".wav"], 
      "audio/webm": [".webm"],
      "audio/ogg": [".ogg"],
      "audio/x-m4a": [".m4a"]
    },
    multiple: false,
  } as any);

  // Recording Logic
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setError(null);
    } catch (err) {
      setError("Microphone access denied or not available.");
      console.error(err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  };

  // Gemini Processing
  const processAudio = async () => {
    if (!audioBlob || !user) return;

    setIsProcessing(true);
    setError(null);

    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = async () => {
        const base64Data = (reader.result as string).split(",")[1];
        
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              parts: [
                { 
                  text: `Analyze this transaction audio for User: ${user.displayName} (UID: ${user.uid}). 
                         Selected Languages: ${selectedLanguages.join(", ")}.
                         Context: Their 30-day average revenue is KES ${avgRevenue}. 
                         Provide the structured JSON output.` 
                },
                {
                  inlineData: {
                    mimeType: audioBlob.type || "audio/webm",
                    data: base64Data,
                  },
                },
              ],
            },
          ],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
          },
        });

        const text = response.text;
        if (text) {
          const parsed: SautiLedgerResponse = JSON.parse(text);
          setResult(parsed);
          
          await addDoc(collection(db, "users", user.uid, "ledger"), {
            ...parsed,
            uid: user.uid,
            timestamp: Timestamp.now()
          });
        } else {
          throw new Error("Empty response from AI");
        }
      };
    } catch (err) {
      setError("Failed to process audio. Please try again.");
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Language-Aware Greeting
  const getGreeting = () => {
    const name = user?.displayName?.split(" ")[0] || "Vendor";
    const isSheng = selectedLanguages.includes("sheng");
    const isSwahili = selectedLanguages.includes("sw");
    
    if (isSheng) return `Sasa, ${name}! Your balance is So.`;
    if (isSwahili) return `Hujambo, ${name}! Salio lako ni KES.`;
    return `Hello, ${name}! Your balance is KES.`;
  };

  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="animate-spin text-gold-500" size={48} />
      </div>
    );
  }

  // STEP 1: IDENTITY
  if (onboardingStep === 0) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-gold-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-glow/10 rounded-full blur-[120px]" />
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full glass rounded-[40px] p-12 text-center relative z-10"
        >
          <div className="w-20 h-20 bg-gold-500/20 rounded-3xl flex items-center justify-center mx-auto mb-8 border border-gold-500/30">
            <ShieldCheck className="text-gold-500" size={40} />
          </div>
          <h1 className="text-4xl font-bold mb-4 tracking-tight">
            Sauti<span className="text-gold-500">Ledger</span>
          </h1>
          <p className="text-white/60 text-sm mb-10 leading-relaxed">
            The specialized financial auditor for informal vendors. 
            Secure your business identity to begin.
          </p>
          
          <div className="space-y-4">
            <button
              onClick={handleLogin}
              className="w-full bg-white text-slate-900 rounded-2xl py-4 text-sm font-bold flex items-center justify-center gap-3 hover:bg-white/90 transition-all active:scale-95"
            >
              <img src="https://www.google.com/favicon.ico" className="w-4 h-4" alt="Google" />
              Continue with Google
            </button>
            <button
              disabled
              className="w-full bg-white/5 border border-white/10 text-white/40 rounded-2xl py-4 text-sm font-bold flex items-center justify-center gap-3 cursor-not-allowed"
            >
              Phone Number (Coming Soon)
            </button>
          </div>
          
          <p className="mt-8 text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold">
            Secure // Encrypted // Verified
          </p>
        </motion.div>
      </div>
    );
  }

  // STEP 2: LANGUAGE PREFERENCE
  if (onboardingStep === 1) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-savannah-green/10 rounded-full blur-[120px]" />
        
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-xl w-full glass rounded-[40px] p-12 relative z-10"
        >
          <h2 className="text-3xl font-bold mb-2">Language Preference</h2>
          <p className="text-white/60 text-sm mb-10">
            Select the languages you use for business. This helps our AI audit your transactions accurately.
          </p>
          
          <div className="grid grid-cols-2 gap-4 mb-10">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.id}
                onClick={() => toggleLanguage(lang.id)}
                className={cn(
                  "flex items-center gap-3 p-4 rounded-2xl border transition-all duration-300",
                  selectedLanguages.includes(lang.id)
                    ? "glass bg-savannah-green/10 glow-green"
                    : "bg-white/5 border-white/10 hover:border-white/30"
                )}
              >
                <span className="text-2xl">{lang.flag}</span>
                <span className="font-semibold">{lang.label}</span>
              </button>
            ))}
          </div>
          
          <button
            onClick={saveLanguages}
            disabled={selectedLanguages.length === 0}
            className="w-full bg-gold-500 text-slate-900 rounded-2xl py-5 text-sm font-bold uppercase tracking-widest hover:bg-gold-500/90 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Start Auditing
          </button>
        </motion.div>
      </div>
    );
  }

  // MAIN DASHBOARD
  return (
    <div className="min-h-screen bg-slate-900 text-white font-sans p-4 md:p-8 relative overflow-hidden">
      {/* Background Blobs */}
      <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-gold-500/5 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[60%] h-[60%] bg-emerald-glow/5 rounded-full blur-[150px] pointer-events-none" />

      <header className="max-w-7xl mx-auto mb-12 flex justify-between items-center relative z-10">
        <div className="flex items-center gap-6">
          <div 
            className="w-14 h-14 rounded-2xl glass flex items-center justify-center border-gold-500/30 shadow-lg shadow-gold-500/10"
            style={{ backgroundColor: getAvatarColor(user.uid) + "30" }}
          >
            <UserIcon className="text-gold-500" size={28} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {getGreeting()}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="px-2 py-0.5 bg-savannah-green/20 text-savannah-green text-[10px] font-bold rounded-full border border-savannah-green/30 uppercase tracking-widest">
                Mode: {selectedLanguages.map(l => LANGUAGES.find(lang => lang.id === l)?.label).join(" + ")}
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="hidden md:block text-right mr-4">
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-bold">Last Sync</p>
            <p className="text-xs font-mono text-gold-500">
              {result?.ui_manifest.profile_header.last_sync || "Awaiting Data..."}
            </p>
          </div>
          <button 
            onClick={handleLogout}
            className="p-3 glass rounded-xl hover:bg-white/10 transition-colors"
          >
            <LogOut size={20} className="text-white/60" />
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 relative z-10">
        {/* Left Column: Input & Stats */}
        <section className="lg:col-span-4 space-y-8">
          <div className="glass rounded-[32px] p-8">
            <h2 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold mb-8">Voice Audit</h2>
            
            <div className="flex flex-col items-center">
              <div className="relative mb-8">
                {isRecording && (
                  <motion.div 
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="absolute inset-0 bg-red-500/20 rounded-full blur-2xl"
                  />
                )}
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={cn(
                    "w-28 h-28 rounded-full flex items-center justify-center transition-all duration-500 relative z-10",
                    isRecording 
                      ? "bg-red-500 shadow-[0_0_30px_rgba(239,68,68,0.5)]" 
                      : "glass hover:bg-white/10 border-white/20"
                  )}
                >
                  {isRecording ? <Square size={36} fill="white" /> : <Mic size={36} className="text-gold-500" />}
                </button>
              </div>
              
              <p className="text-sm font-semibold mb-8">
                {isRecording ? "Listening to Sauti..." : "Tap to record transaction"}
              </p>

              {isRecording && (
                <div className="mb-8">
                  <AnimatedWaveform />
                </div>
              )}

              <div className="w-full h-[1px] bg-white/10 flex items-center justify-center mb-8">
                <span className="bg-slate-900 px-4 text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold">OR</span>
              </div>

              <div 
                {...getRootProps()} 
                className={cn(
                  "w-full border border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all",
                  isDragActive ? "border-gold-500 bg-gold-500/5" : "border-white/10 hover:border-white/30"
                )}
              >
                <input {...getInputProps()} />
                <Upload className="mx-auto mb-2 text-white/40" size={24} />
                <p className="text-xs text-white/40">Upload Audio File</p>
              </div>
            </div>

            {audioBlob && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-10 space-y-4"
              >
                <div ref={waveformRef} className="w-full glass-dark rounded-2xl p-4" />
                <button
                  onClick={processAudio}
                  disabled={isProcessing}
                  className="w-full bg-gold-500 text-slate-900 rounded-2xl py-5 text-sm font-bold uppercase tracking-widest hover:bg-gold-500/90 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
                >
                  {isProcessing ? (
                    <Loader2 className="animate-spin" size={20} />
                  ) : (
                    <>
                      <Zap size={20} />
                      Audit Transaction
                    </>
                  )}
                </button>
              </motion.div>
            )}
          </div>

          {/* Predictive Widget */}
          <div className="glass rounded-[32px] p-8 border-gold-500/20">
            <div className="flex justify-between items-start mb-8">
              <h2 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold">Predictive Cash Flow</h2>
              <TrendingUp className="text-gold-500" size={20} />
            </div>
            <div className="space-y-6">
              <div>
                <p className="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold mb-1">Next Week Prediction</p>
                <p className="text-4xl font-bold text-gold-500">KES {result?.future_projections.next_7_days_prediction.toLocaleString() || "---"}</p>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold">Loan Readiness</p>
                  <p className="text-xs font-bold text-gold-500">{result?.future_projections.loan_readiness_meter || 0}%</p>
                </div>
                <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${result?.future_projections.loan_readiness_meter || 0}%` }}
                    className="h-full bg-gold-500"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Right Column: Results & History */}
        <section className="lg:col-span-8 space-y-8">
          <AnimatePresence mode="wait">
            {!result && !isProcessing ? (
              <motion.div 
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="h-[400px] flex flex-col items-center justify-center text-center p-12 glass rounded-[32px] border-dashed border-white/10"
              >
                <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6">
                  <Volume2 className="text-white/20" size={40} />
                </div>
                <h3 className="text-2xl font-bold mb-2">Awaiting Sauti</h3>
                <p className="text-white/40 text-sm max-w-xs">
                  Record your first transaction to see the Nairobi Modern ledger in action.
                </p>
              </motion.div>
            ) : isProcessing ? (
              <motion.div 
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="h-[400px] flex flex-col items-center justify-center text-center p-12 glass rounded-[32px]"
              >
                <div className="relative mb-8">
                  <Loader2 className="animate-spin text-gold-500" size={64} />
                  <div className="absolute inset-0 bg-gold-500/20 blur-2xl rounded-full" />
                </div>
                <h3 className="text-3xl font-bold mb-4">Auditing Sauti...</h3>
                <p className="text-[10px] uppercase tracking-[0.4em] text-gold-500 font-bold animate-pulse">
                  Applying Language Weights
                </p>
              </motion.div>
            ) : (
              <motion.div 
                key="result"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="space-y-8"
              >
                {/* Hero Summary Card */}
                <div className="glass rounded-[40px] p-10 relative overflow-hidden border-white/10">
                  <div className="absolute top-0 right-0 p-6">
                    {result?.data_privacy_flag && (
                      <div className="flex items-center gap-2 bg-red-500/20 text-red-500 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest border border-red-500/30">
                        <Lock size={12} /> Privacy Flagged
                      </div>
                    )}
                  </div>
                  
                  <div className="relative z-10">
                    <p className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-bold mb-4">Transaction Summary</p>
                    <h2 className="text-6xl font-bold tracking-tighter mb-6 text-gold-500">
                      {result?.ui_manifest.hero_metric}
                    </h2>
                    <p className="text-2xl font-medium text-white/90 leading-tight">
                      "{result?.ui_manifest.sheng_summary}"
                    </p>
                  </div>
                  
                  <div className="absolute -right-20 -bottom-20 w-80 h-80 bg-gold-500/10 rounded-full blur-[100px]" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Transaction Details */}
                  <div className="glass rounded-[32px] p-8">
                    <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold mb-8 flex items-center gap-3">
                      <BarChart3 size={18} className="text-gold-500" /> 
                      Ledger Breakdown
                    </h3>
                    <div className="space-y-6">
                      <div className="flex justify-between items-center border-b border-white/5 pb-4">
                        <span className="text-sm text-white/40">Item / Qty</span>
                        <span className="text-lg font-bold">{result?.transaction_details.item} ({result?.transaction_details.quantity})</span>
                      </div>
                      <div className="flex justify-between items-center border-b border-white/5 pb-4">
                        <span className="text-sm text-white/40">Total Value</span>
                        <span className="text-lg font-bold">KES {result?.transaction_details.total_value}</span>
                      </div>
                      <div className="flex justify-between items-center border-b border-white/5 pb-4">
                        <span className="text-sm text-white/40">Amount Paid</span>
                        <span className="text-lg font-bold text-emerald-glow">KES {result?.transaction_details.amount_paid}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-white/40">Deni (Debt)</span>
                        <span className={cn(
                          "text-lg font-bold",
                          (result?.transaction_details.debt ?? 0) > 0 ? "text-amber-pulse" : "text-emerald-glow"
                        )}>
                          KES {result?.transaction_details.debt}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Credit Insight */}
                  <div className="glass rounded-[32px] p-8">
                    <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold mb-8 flex items-center gap-3">
                      <ShieldCheck size={18} className="text-emerald-glow" /> 
                      Credit Insight
                    </h3>
                    <div className="space-y-6">
                      <div className="flex items-center gap-6">
                        <div className="w-20 h-20 rounded-2xl glass flex items-center justify-center border-emerald-glow/30">
                          <span className="text-2xl font-bold text-emerald-glow">{result?.credit_insight.trust_score_out_of_100}</span>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold mb-1">Trust Score</p>
                          <p className="text-xs text-white/60 leading-relaxed">
                            {result?.credit_insight.risk_reasoning}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Historical Ledger */}
          <div className="glass rounded-[32px] p-8">
            <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold mb-8 flex items-center gap-3">
              <History size={18} className="text-white/40" /> 
              Historical Ledger
            </h3>
            <div className="space-y-4">
              {history.map((entry, idx) => (
                <motion.div 
                  key={idx}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className={cn(
                    "p-5 rounded-2xl glass-dark border-l-4 flex justify-between items-center",
                    entry.transaction_details.debt > 0 ? "border-amber-pulse glow-amber" : "border-emerald-glow glow-emerald"
                  )}
                >
                  <div>
                    <p className="text-sm font-bold">{entry.transaction_details.item}</p>
                    <p className="text-[10px] text-white/30 uppercase tracking-widest mt-1">
                      {entry.timestamp.toDate().toLocaleDateString()} • {entry.transaction_details.quantity}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold">KES {entry.transaction_details.total_value}</p>
                    <p className={cn(
                      "text-[10px] font-bold uppercase tracking-widest mt-1",
                      entry.transaction_details.debt > 0 ? "text-amber-pulse" : "text-emerald-glow"
                    )}>
                      {entry.transaction_details.debt > 0 ? `Deni: ${entry.transaction_details.debt}` : "Paid"}
                    </p>
                  </div>
                </motion.div>
              ))}
              {history.length === 0 && (
                <p className="text-center py-8 text-white/20 text-sm italic">No history yet.</p>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="max-w-7xl mx-auto mt-20 pt-10 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-6 relative z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 bg-savannah-green rounded-full animate-pulse" />
          <p className="text-[10px] uppercase tracking-[0.4em] text-white/30 font-bold">
            Sauti-Ledger Engine // Nairobi Modern v2.0
          </p>
        </div>
        <div className="flex gap-8">
          <a href="#" className="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold hover:text-gold-500 transition-colors">Privacy</a>
          <a href="#" className="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold hover:text-gold-500 transition-colors">Security</a>
          <a href="#" className="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold hover:text-gold-500 transition-colors">Support</a>
        </div>
      </footer>
    </div>
  );
}

