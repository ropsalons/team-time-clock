// Employee help. The FIRST and most important thing is installing it to the home
// screen, with explicit iPhone AND Android steps — that's where people struggle.

export default function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl p-5 safe-bottom max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-brand-ink">How to use the time clock</h2>
          <button onClick={onClose} className="text-neutral-400 text-2xl leading-none">&times;</button>
        </div>

        {/* Step 1 — install to home screen, highlighted */}
        <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-4 mb-4">
          <div className="font-semibold text-brand-ink">📲 First: add this to your phone like an app</div>
          <p className="text-sm text-neutral-600 mt-1">Do this once. Then you just tap the Team clock icon to open it — no typing a web address.</p>

          <div className="mt-3">
            <div className="font-medium text-brand-ink text-sm"> iPhone (Safari)</div>
            <ol className="text-sm text-neutral-700 list-decimal list-inside space-y-0.5 mt-1">
              <li>Make sure you're in <b>Safari</b> (not Chrome).</li>
              <li>Tap the <b>Share</b> button — the square with an up-arrow at the bottom.</li>
              <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
              <li>Tap <b>Add</b> in the top-right. The clock icon is now on your home screen.</li>
            </ol>
          </div>

          <div className="mt-3">
            <div className="font-medium text-brand-ink text-sm">🤖 Android (Chrome)</div>
            <ol className="text-sm text-neutral-700 list-decimal list-inside space-y-0.5 mt-1">
              <li>Tap the <b>⋮</b> menu (three dots, top-right).</li>
              <li>Tap <b>Add to Home screen</b> (or <b>Install app</b>).</li>
              <li>Tap <b>Add</b> / <b>Install</b>. The clock icon appears on your home screen.</li>
            </ol>
          </div>
        </div>

        <ul className="space-y-3">
          {[
            { icon: '🔐', title: 'Sign in', body: 'Use your work email and the password you created. First time? Tap "First time here? Set up your account" and pick a password.' },
            { icon: '🟢', title: 'Clock in', body: 'Check your Location and Department at the top, then tap the big green CLOCK IN button. The timer starts.' },
            { icon: '🔴', title: 'Clock out', body: 'When you\'re done, tap the big red CLOCK OUT button. Your hours save automatically.' },
            { icon: '🔄', title: 'Change department or location', body: 'Moving to a different department or salon during your shift? Change it at the top before you clock out.' },
            { icon: '✏️', title: 'Forgot a punch?', body: 'Tap "Report a missed or incorrect punch," say what happened, and a manager will fix it.' },
          ].map((s) => (
            <li key={s.title} className="flex gap-3">
              <span className="text-2xl leading-none">{s.icon}</span>
              <div><div className="font-medium text-brand-ink">{s.title}</div><div className="text-sm text-neutral-600">{s.body}</div></div>
            </li>
          ))}
        </ul>

        <p className="text-xs text-neutral-400 mt-4 text-center">Still stuck? Ask your manager — they can help right away.</p>
        <button onClick={onClose} className="w-full rounded-xl bg-emerald-600 text-white py-3 font-bold mt-4">Got it</button>
      </div>
    </div>
  );
}
