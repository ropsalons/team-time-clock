import { useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';

type Method = 'phone' | 'email';
type EmailMode = 'signin' | 'setup' | 'reset';
type PhoneMode = 'signin' | 'setup' | 'forgot' | 'forgot_code';

export default function LoginScreen() {
  const auth = useAuth();
  const { signIn, activate } = auth;
  // The Phone tab is now Central Login (your central login app) — one mobile
  // number + 4-digit PIN shared across all four Team properties. Email stays on
  // this project for admins.
  const phoneSignIn = auth.centralSignIn;
  const phoneSetup = auth.centralSetup;
  const phoneForgot = auth.centralForgot;
  const phoneReset = auth.centralReset;
  const [method, setMethod] = useState<Method>('phone');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // email state
  const [emailMode, setEmailMode] = useState<EmailMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // phone state
  const [phoneMode, setPhoneMode] = useState<PhoneMode>('signin');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');

  const reset = () => { setErr(null); setNote(null); setPassword(''); setPin(''); setCode(''); };
  const pickMethod = (m: Method) => { setMethod(m); reset(); };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true); setErr(null);
    try {
      if (emailMode === 'signin') await signIn(email, password);
      else await activate(email, password);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  };

  const submitPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null); setNote(null);
    try {
      if (phoneMode === 'signin') { if (!phone || pin.length !== 4) return; await phoneSignIn(phone, pin); }
      else if (phoneMode === 'setup') { if (!phone || pin.length !== 4) return; await phoneSetup(phone, pin); }
      else if (phoneMode === 'forgot') {
        if (!phone) return;
        await phoneForgot(phone);
        setNote('If that number is on file, we just texted you a 6-digit code. Enter it below with a new PIN.');
        setPhoneMode('forgot_code');
      } else { // forgot_code
        if (!code || pin.length !== 4) return;
        await phoneReset(phone, code, pin);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  };

  const goPhone = (m: PhoneMode) => { setPhoneMode(m); reset(); };
  const goEmail = (m: EmailMode) => { setEmailMode(m); reset(); };

  const pinField = (label: string, ph: string) => (
    <>
      <label className="text-sm font-medium text-brand-ink" htmlFor="pin">{label}</label>
      <input id="pin" type="password" inputMode="numeric" autoComplete="off" required
        value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
        placeholder={ph} maxLength={4}
        className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-2xl tracking-[0.5em] text-center bg-white" />
    </>
  );
  const phoneField = (
    <>
      <label className="text-sm font-medium text-brand-ink" htmlFor="phone">Mobile number</label>
      <input id="phone" type="tel" inputMode="tel" autoComplete="tel" required
        value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 555-0100"
        className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-base bg-white" />
    </>
  );

  const phoneBtn =
    phoneMode === 'signin' ? 'Sign in' :
    phoneMode === 'setup' ? 'Set my PIN' :
    phoneMode === 'forgot' ? 'Text me a code' : 'Set new PIN & sign in';

  return (
    <div className="min-h-full flex flex-col items-center justify-center px-6 bg-brand-cream safe-top safe-bottom">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="font-semibold tracking-wide text-brand-ink">SAMPLE SALON CO</div>
          <div className="text-sm text-neutral-500">Team Time Clock</div>
        </div>

        {/* method toggle */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-neutral-200/70 rounded-2xl mb-4">
          <button onClick={() => pickMethod('phone')} className={`rounded-xl py-2 text-sm font-semibold ${method === 'phone' ? 'bg-white text-brand-ink shadow' : 'text-neutral-600'}`}>Phone + PIN</button>
          <button onClick={() => pickMethod('email')} className={`rounded-xl py-2 text-sm font-semibold ${method === 'email' ? 'bg-white text-brand-ink shadow' : 'text-neutral-600'}`}>Email</button>
        </div>

        {note && <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-3">{note}</div>}

        {method === 'phone' ? (
          <>
            {/* First-time users don't have a PIN yet — make setup the obvious first choice. */}
            {phoneMode === 'signin' && (
              <div className="mb-5 rounded-2xl border-2 border-emerald-500 bg-emerald-50 p-4 text-center">
                <div className="font-semibold text-brand-ink text-base">First time logging in?</div>
                <div className="text-sm text-neutral-600 mt-1 mb-3">You don't have a PIN yet — set one up now. It only takes a few seconds.</div>
                <button onClick={() => goPhone('setup')} className="w-full rounded-2xl py-3.5 text-lg font-bold text-white bg-emerald-600">Set up my PIN &rarr;</button>
              </div>
            )}
            {phoneMode !== 'signin' && (
              <div className="text-sm text-neutral-600 bg-white border border-neutral-200 rounded-xl px-4 py-3 mb-3">
                {phoneMode === 'setup' && "First time here — enter the mobile number we texted, then pick a 4-digit PIN. That becomes your login."}
                {phoneMode === 'forgot' && "Enter your mobile number and we'll text you a code to set a new PIN."}
                {phoneMode === 'forgot_code' && 'Enter the code from your text and choose a new 4-digit PIN.'}
              </div>
            )}
            {phoneMode === 'signin' && (
              <div className="text-xs uppercase tracking-wide text-neutral-400 text-center mb-2">Already set up? Sign in</div>
            )}
            <form onSubmit={submitPhone} className="flex flex-col gap-3">
              {phoneMode !== 'forgot_code' && phoneField}
              {phoneMode === 'signin' && pinField('PIN', '••••')}
              {phoneMode === 'setup' && pinField('Choose a 4-digit PIN', '••••')}
              {phoneMode === 'forgot_code' && (
                <>
                  <label className="text-sm font-medium text-brand-ink" htmlFor="code">6-digit code</label>
                  <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" required
                    value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" maxLength={6}
                    className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-xl tracking-[0.3em] text-center bg-white" />
                  {pinField('New 4-digit PIN', '••••')}
                </>
              )}
              {err && <div className="text-sm text-red-600">{err}</div>}
              <button type="submit" disabled={busy} className={`w-full rounded-2xl py-4 text-lg font-bold text-white disabled:opacity-60 mt-1 ${phoneMode === 'signin' ? 'bg-brand-ink' : 'bg-emerald-600'}`}>
                {busy ? 'Please wait…' : phoneBtn}
              </button>
            </form>
            <div className="mt-5 flex flex-col items-center gap-2 text-sm">
              {phoneMode === 'signin' ? (
                <button onClick={() => goPhone('forgot')} className="text-emerald-700 underline font-medium">Forgot your PIN?</button>
              ) : (
                <button onClick={() => goPhone('signin')} className="text-neutral-500 underline">Already have a PIN? Sign in</button>
              )}
            </div>
          </>
        ) : (
          <>
            {emailMode !== 'signin' && (
              <div className="text-sm text-neutral-600 bg-white border border-neutral-200 rounded-xl px-4 py-3 mb-3">
                {emailMode === 'reset'
                  ? 'Enter your work email and a new password. This resets your password and signs you in.'
                  : 'First time? Enter your work email and pick a password to activate your account.'}
              </div>
            )}
            <form onSubmit={submitEmail} className="flex flex-col gap-3">
              <label className="text-sm font-medium text-brand-ink" htmlFor="email">Work email</label>
              <input id="email" type="email" inputMode="email" autoComplete="email" required
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-base bg-white" />
              <label className="text-sm font-medium text-brand-ink" htmlFor="password">
                {emailMode === 'signin' ? 'Password' : emailMode === 'setup' ? 'Choose a password' : 'Choose a new password'}
              </label>
              <input id="password" type="password" required minLength={8}
                autoComplete={emailMode === 'signin' ? 'current-password' : 'new-password'}
                value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder={emailMode === 'signin' ? 'Your password' : 'At least 8 characters'}
                className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-base bg-white" />
              {err && <div className="text-sm text-red-600">{err}</div>}
              <button type="submit" disabled={busy} className="w-full rounded-2xl py-4 text-lg font-bold text-white bg-emerald-600 disabled:opacity-60 mt-1">
                {busy ? 'Please wait…' : emailMode === 'signin' ? 'Sign in' : emailMode === 'setup' ? 'Set up my account' : 'Reset my password'}
              </button>
            </form>
            <div className="mt-5 flex flex-col items-center gap-2 text-sm">
              {emailMode === 'signin' ? (
                <>
                  <button onClick={() => goEmail('reset')} className="text-emerald-700 underline font-medium">Forgot your password?</button>
                  <button onClick={() => goEmail('setup')} className="text-neutral-500 underline">First time here? Set up your account</button>
                </>
              ) : (
                <button onClick={() => goEmail('signin')} className="text-neutral-500 underline">Already set up? Sign in</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
