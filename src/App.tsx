import { useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import LoginScreen from './features/auth/LoginScreen';
import EmployeeHome from './features/clock/EmployeeHome';
import AdminApp from './features/admin/AdminApp';

export default function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}

function Router() {
  const { session, employee, isAdmin, status, signOut } = useAuth();
  // Deep link: ?view=me opens straight to the signed-in user's OWN timesheet
  // (their clock screen with status + recent punches), never a company-wide/admin
  // view — used by the Team Team App. Admins can still switch to Admin afterward.
  const [adminView, setAdminView] = useState(() => new URLSearchParams(window.location.search).get('view') !== 'me');

  if (status === 'unconfigured') return <Notice title="Not configured" body="Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then reload." />;
  if (status === 'loading') return <Notice title="Loading…" body="" />;
  if (!session) return <LoginScreen />;

  if (status === 'linked' && employee) {
    if (isAdmin && adminView)
      return <AdminApp firstName={employee.first_name} onSignOut={signOut} onSwitchToClock={() => setAdminView(false)} />;
    return (
      <div>
        {isAdmin && (
          <button onClick={() => setAdminView(true)}
            className="fixed top-2 right-2 z-20 text-xs bg-brand-ink text-white rounded-full px-3 py-1 shadow">Admin ▸</button>
        )}
        <EmployeeHome firstName={employee.first_name} employeeId={employee.id}
          defaultLocationId={employee.home_location_id ?? null} defaultDepartmentId={employee.home_department_id ?? null}
          canManageOwnTime={!!employee.can_manage_own_time}
          onSignOut={signOut} />
      </div>
    );
  }

  if (status === 'not_enabled')
    return <Notice title="Access not enabled yet" body="Your account is recognized but an administrator hasn't turned on time-clock access. Please check with your manager." onSignOut={signOut} />;
  if (status === 'no_match')
    return <Notice title="No matching employee" body="We couldn't match your email to an employee record. Please contact an administrator." onSignOut={signOut} />;

  return <Notice title="Signing in…" body="" />;
}

function Notice({ title, body, onSignOut }: { title: string; body: string; onSignOut?: () => void }) {
  return (
    <div className="min-h-full flex flex-col items-center justify-center px-6 text-center bg-brand-cream safe-top safe-bottom">
      <div className="w-full max-w-sm">
        <div className="font-semibold tracking-wide text-brand-ink">SAMPLE SALON CO</div>
        <div className="text-sm text-neutral-500 mb-6">Team Time Clock</div>
        <h1 className="text-lg font-semibold text-brand-ink">{title}</h1>
        {body && <p className="text-sm text-neutral-500 mt-1">{body}</p>}
        {onSignOut && <button onClick={onSignOut} className="mt-6 text-sm text-neutral-500 underline">Sign out</button>}
      </div>
    </div>
  );
}
