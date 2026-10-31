import { describe, it, expect } from 'vitest';
import { mapGustoEmployee, inferLocationFromTitle, nextAccess, type GustoEmployee } from './mapping';

const base: GustoEmployee = {
  uuid: '00000000-0000-4000-8000-000000000001',
  company_uuid: '00000000-0000-4000-8000-000000000002',
  first_name: 'Alex', middle_initial: '', last_name: 'Sample',
  preferred_first_name: '', email: 'sample@example.com', phone: null,
  current_employment_status: 'full_time', terminated: false, department: 'Stylist',
  version: 'v1',
  jobs: [{ primary: true, title: 'Stylist Uptown', rate: '60.00', hire_date: '1982-01-19',
           compensations: [{ flsa_status: 'Nonexempt' }] }],
};

describe('inferLocationFromTitle', () => {
  it('extracts salon from real Gusto titles', () => {
    expect(inferLocationFromTitle('Stylist Uptown')).toBe('Uptown');
    expect(inferLocationFromTitle('Associate Downtown')).toBe('Downtown');
    expect(inferLocationFromTitle('Manager Lakeside')).toBe('Lakeside');
    expect(inferLocationFromTitle('Concierge')).toBeNull();
    expect(inferLocationFromTitle(null)).toBeNull();
  });
});

describe('mapGustoEmployee', () => {
  it('maps identity, normalises empties to null, infers location', () => {
    const m = mapGustoEmployee(base);
    expect(m.gusto_employee_uuid).toBe(base.uuid);
    expect(m.middle_initial).toBeNull();
    expect(m.preferred_first_name).toBeNull();
    expect(m.primary_job_title).toBe('Stylist Uptown');
    expect(m.inferred_location_short).toBe('Uptown');
    expect(m.flsa_status).toBe('Nonexempt');
    expect(m.employment_status).toBe('full_time');
    expect(m.termination_date).toBeNull();
  });

  it('a name change keeps the same identity key (no duplicate)', () => {
    const renamed = { ...base, last_name: 'Miller', email: 'new@x.com', version: 'v2' };
    expect(mapGustoEmployee(renamed).gusto_employee_uuid).toBe(mapGustoEmployee(base).gusto_employee_uuid);
  });

  it('marks terminated employees', () => {
    const t = { ...base, terminated: true, terminations: [{ effective_date: '2026-01-31' }] };
    const m = mapGustoEmployee(t);
    expect(m.employment_status).toBe('terminated');
    expect(m.termination_date).toBe('2026-01-31');
  });
});

describe('nextAccess (preserves admin decisions)', () => {
  it('new employee -> pending_review', () => {
    expect(nextAccess(null, false)).toBe('pending_review');
  });
  it('active in Gusto does not auto-grant access', () => {
    expect(nextAccess('pending_review', false)).toBe('pending_review');
    expect(nextAccess('enabled', false)).toBe('enabled');
  });
  it('termination disables punching', () => {
    expect(nextAccess('enabled', true)).toBe('terminated_in_gusto');
  });
  it('admin-resolved disable survives termination sync', () => {
    expect(nextAccess('disabled', true)).toBe('disabled');
    expect(nextAccess('suspended', true)).toBe('suspended');
  });
  it('rehire after local termination flags a conflict for review', () => {
    expect(nextAccess('terminated_in_gusto', false)).toBe('sync_conflict');
  });
});
