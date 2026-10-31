// A short, empowering quote shown to employees each day. Rotates deterministically
// by day so everyone sees the same one, and it changes every morning.

export interface Quote { text: string; author: string }

export const QUOTES: Quote[] = [
  { text: 'You are one decision away from a completely different life.', author: 'Mel Robbins' },
  { text: 'The only impossible journey is the one you never begin.', author: 'Tony Robbins' },
  { text: 'Compare yourself to who you were yesterday, not to who someone else is today.', author: 'Jordan Peterson' },
  { text: 'Change the way you look at things and the things you look at change.', author: 'Wayne Dyer' },
  { text: 'You have to take the risk to find out how good you can be.', author: 'Mel Robbins' },
  { text: 'The path to success is to take massive, determined action.', author: 'Tony Robbins' },
  { text: 'You cannot always control what goes on outside. But you can always control what goes on inside.', author: 'Wayne Dyer' },
  { text: 'Set your house in perfect order before you criticize the world.', author: 'Jordan Peterson' },
  { text: 'Either you run the day or the day runs you.', author: 'Jim Rohn' },
  { text: "You don't have to be great to start, but you have to start to be great.", author: 'Zig Ziglar' },
  { text: 'People will forget what you said, but never how you made them feel.', author: 'Maya Angelou' },
  { text: 'What lies within us is far greater than what lies behind or before us.', author: 'Ralph Waldo Emerson' },
  { text: 'Your present circumstances don’t determine where you can go; they merely determine where you start.', author: 'Nido Qubein' },
  { text: 'Act as if what you do makes a difference. It does.', author: 'William James' },
  { text: 'Do the best you can until you know better. Then when you know better, do better.', author: 'Maya Angelou' },
  { text: 'Success is the sum of small efforts repeated day in and day out.', author: 'Robert Collier' },
  { text: 'The way to get started is to quit talking and begin doing.', author: 'Walt Disney' },
  { text: 'Believe you can and you’re halfway there.', author: 'Theodore Roosevelt' },
  { text: 'Little by little, one travels far.', author: 'J.R.R. Tolkien' },
  { text: 'Whatever you are, be a good one.', author: 'Abraham Lincoln' },
];

/** Same quote for everyone on a given Team-local day; advances each morning. */
export function quoteForDay(now: Date): Quote {
  const key = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const dayNum = Math.floor(Date.parse(`${key}T00:00:00Z`) / 86400000);
  return QUOTES[((dayNum % QUOTES.length) + QUOTES.length) % QUOTES.length];
}
