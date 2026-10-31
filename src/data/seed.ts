// Sample seed config (fake locations). Replace with your own.
// These become rows in `locations` / `departments`; both stay admin-editable.

export interface SeedLocation {
  short_name: string;
  display_name: string;
  address: string;
  gusto_location_uuid?: string;
  is_active: boolean;
}

export const SEED_LOCATIONS: SeedLocation[] = [
  { short_name: 'Downtown', display_name: 'Downtown — Springfield',
    address: '100 Main St, Springfield, ST 00000', is_active: true },
  { short_name: 'Uptown', display_name: 'Uptown — Springfield',
    address: '200 Oak Ave, Springfield, ST 00000', is_active: true },
  { short_name: 'Lakeside', display_name: 'Lakeside — Shelbyville',
    address: '300 Lake Rd, Shelbyville, ST 00000', is_active: true },
];

// Timeclock departments — seeded from Gusto department names, admin-editable.
export const SEED_DEPARTMENTS: string[] = [
  'Stylist', 'Associate', 'Concierge', 'Admin', 'Nails', 'Management', 'Other',
];

// Default application settings (mirrors app_settings table keys).
export const DEFAULT_SETTINGS = {
  company_name: 'Sample Salon Co',
  time_zone: 'America/New_York',
  pay_period_anchor_end: '2020-04-26',
  pay_period_length_days: 14,
  require_location: true,
  require_department: true,
  gps_mode: 'off', // off | optional | warn | required
  allow_location_transfers: true,
  allow_department_transfers: true,
  breaks_enabled: false,
  corrections_require_approval: true,
  long_shift_alert_hours: 12,
  max_shift_hours: 16,
} as const;
