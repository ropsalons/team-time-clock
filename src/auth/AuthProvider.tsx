import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, isConfigured } from '../lib/supabase';
import { linkAccount, setPassword, loginPhone, setPin, resetPin, forgotPin, whoami, type PhoneSession } from '../lib/api';
import { centralLogin, centralProfilePhone } from '../lib/chatAuth';

type LinkStatus = 'loading' | 'linked' | 'no_match' | 'not_enabled' | 'signed_out' | 'unconfigured';

interface EmployeeLite { id: string; first_name: string; home_location_id?: string | null; home_department_id?: string | null; can_manage_own_time?: boolean }

interface AuthCtx {
  session: Session | null;
  employee: EmployeeLite | null;
  roles: string[];
  isAdmin: boolean;
  status: LinkStatus;
  // Legacy (this project) — email admins + pre-cutover phone.
  signIn: (email: string, password: string) => Promise<void>;
  activate: (email: string, password: string) => Promise<void>;
  signInPhone: (phone: string, pin: string) => Promise<void>;
  activatePin: (phone: string, pin: string) => Promise<void>;
  requestPinReset: (phone: string) => Promise<void>;
  completePinReset: (phone: string, code: string, pin: string) => Promise<void>;
  // Central Login (your central login app) — the shared identity.
  centralSignIn: (phone: string, pin: string) => Promise<void>;
  centralSetup: (phone: string, pin: string) => Promise<void>;
  centralForgot: (phone: string) => Promise<void>;
  centralReset: (phone: string, code: string, pin: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [legacySession, setLegacySession] = useState<Session | null>(null);
  const [centralSession, setCentralSession] = useState<Session | null>(null);
  const [employee, setEmployee] = useState<EmployeeLite | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [status, setStatus] = useState<LinkStatus>(isConfigured ? 'loading' : 'unconfigured');

  // Legacy (this project) session.
  useEffect(() => {
    if (!isConfigured) return;
    supabase.auth.getSession().then(({ data }) => setLegacySession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setLegacySession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Central (chat) session.
  useEffect(() => {
    centralLogin.getSession().then(setCentralSession).catch(() => setCentralSession(null));
    const { data: sub } = centralLogin.onChange(setCentralSession);
    return () => sub.subscription.unsubscribe();
  }, []);

  // Central wins when present; otherwise fall back to the legacy session.
  const activeSession = centralSession ?? legacySession;
  const usingCentral = !!centralSession;

  // Resolve the employee + roles for whichever session is active.
  useEffect(() => {
    if (!isConfigured) return;
    if (!activeSession) { setEmployee(null); setRoles([]); setStatus('signed_out'); return; }
    let cancelled = false;
    setStatus('loading');
    const resolve = usingCentral
      ? whoami(centralProfilePhone()).then((r) => {
          if (cancelled) return;
          setRoles(r.roles ?? []);
          if (r.ok && r.employee) { setEmployee(r.employee); setStatus('linked'); }
          else setStatus((r.status as LinkStatus) ?? 'no_match');
        })
      : linkAccount().then((r) => {
          if (cancelled) return;
          setRoles(((r as { roles?: string[] }).roles) ?? []);
          if (r.ok && r.employee) { setEmployee(r.employee as EmployeeLite); setStatus('linked'); }
          else setStatus((r.status as LinkStatus) ?? 'no_match');
        });
    resolve.catch(() => !cancelled && setStatus('no_match'));
    return () => { cancelled = true; };
  }, [activeSession, usingCentral]);

  // --- Legacy (this project) ---
  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw error;
  };
  const activate = async (email: string, password: string) => {
    const r = await setPassword(email.trim().toLowerCase(), password);
    if (!r.ok) {
      if (r.status === 'not_enabled') throw new Error('Your time-clock access is not enabled yet. Ask an administrator.');
      if (r.status === 'no_match') throw new Error("We couldn't find an employee with that email.");
      throw new Error('Could not set up your account.');
    }
    await signIn(email, password);
  };
  const adoptLegacy = async (r: PhoneSession) => {
    const { error } = await supabase.auth.setSession({ access_token: r.access_token, refresh_token: r.refresh_token });
    if (error) throw error;
  };
  const signInPhone = async (phone: string, pin: string) => { await adoptLegacy(await loginPhone(phone.trim(), pin.trim())); };
  const activatePin = async (phone: string, pin: string) => {
    const r = await setPin(phone.trim(), pin.trim());
    if (!r.ok) {
      if (r.status === 'not_enabled') throw new Error('Your time-clock access is not enabled yet. Ask an administrator.');
      if (r.status === 'no_match') throw new Error("We couldn't find your mobile number on file. Ask an administrator to add it.");
      throw new Error('Could not set up your account.');
    }
    await adoptLegacy(r);
  };
  const requestPinReset = async (phone: string) => { await forgotPin(phone.trim()); };
  const completePinReset = async (phone: string, code: string, pin: string) => { await adoptLegacy(await resetPin(phone.trim(), code.trim(), pin.trim())); };

  // --- Central Login (your central login app) ---
  const centralSignIn = async (phone: string, pin: string) => {
    const r = await centralLogin.login(phone.trim(), pin.trim());
    if (!r.ok) throw new Error(r.error || 'That phone number or PIN is not right.');
  };
  const centralSetup = async (phone: string, pin: string) => {
    const r = await centralLogin.setup(phone.trim(), pin.trim());
    if (!r.ok) throw new Error(r.error || 'Could not set up your PIN.');
  };
  const centralForgot = async (phone: string) => {
    const r = await centralLogin.forgot(phone.trim());
    if (!r.ok) throw new Error(r.error || 'Could not send a reset code.');
  };
  const centralReset = async (phone: string, code: string, pin: string) => {
    const r = await centralLogin.reset(phone.trim(), code.trim(), pin.trim());
    if (!r.ok) throw new Error(r.error || 'Could not reset your PIN.');
  };

  const signOut = async () => {
    await Promise.all([centralLogin.signOut().catch(() => {}), supabase.auth.signOut().catch(() => {})]);
    setEmployee(null); setRoles([]);
  };

  const isAdmin = roles.includes('payroll_admin') || roles.includes('system_admin');
  return (
    <Ctx.Provider value={{
      session: activeSession, employee, roles, isAdmin, status,
      signIn, activate, signInPhone, activatePin, requestPinReset, completePinReset,
      centralSignIn, centralSetup, centralForgot, centralReset, signOut,
    }}>{children}</Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
