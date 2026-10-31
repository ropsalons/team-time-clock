import { describe, it, expect } from 'vitest';
import { sanitizeCell, buildPayrollCsv, jobTitle, type ExportRow } from './csv';

describe('sanitizeCell (formula-injection protection)', () => {
  it('prefixes dangerous leading characters', () => {
    expect(sanitizeCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(sanitizeCell('+1')).toBe("'+1");
    expect(sanitizeCell('-1+2')).toBe("'-1+2");
    expect(sanitizeCell('@cmd')).toBe("'@cmd");
  });
  it('leaves safe values alone', () => {
    expect(sanitizeCell('Alex Sample')).toBe('Alex Sample');
    expect(sanitizeCell(8.25)).toBe('8.25');
  });
  it('RFC-4180 quotes commas, quotes and newlines', () => {
    expect(sanitizeCell('Doe, Jane')).toBe('"Doe, Jane"');
    expect(sanitizeCell('a"b')).toBe('"a""b"');
  });
});

describe('jobTitle (matches Gusto naming)', () => {
  it('combines department + location', () => {
    expect(jobTitle('Stylist', 'Uptown')).toBe('Stylist Uptown');
    expect(jobTitle('Concierge', 'Downtown')).toBe('Concierge Downtown');
    expect(jobTitle('Admin', '')).toBe('Admin');
  });
});

describe('buildPayrollCsv (per-job rows)', () => {
  const row = (over: Partial<ExportRow>): ExportRow => ({
    gusto_employee_uuid: 'b957ce80', employee_name: 'Alex Sample', email: 'd@x.com',
    pay_period_start: '2026-06-29', pay_period_end: '2026-07-12',
    job_title: 'Stylist Uptown', location: 'Uptown', department: 'Stylist',
    regular_seconds: 40 * 3600, overtime_seconds: 90 * 60, double_ot_seconds: 0, ...over,
  });
  it('emits Job Title header and decimal hours', () => {
    const csv = buildPayrollCsv([row({})]);
    const [header, line] = csv.split('\r\n');
    expect(header).toContain('Job Title');
    expect(line).toContain('Stylist Uptown');
    expect(line).toContain('40,1.5,0');
  });
  it('a two-department employee produces two rows', () => {
    const csv = buildPayrollCsv([
      row({ job_title: 'Stylist Uptown', department: 'Stylist', location: 'Uptown', regular_seconds: 30 * 3600, overtime_seconds: 0 }),
      row({ job_title: 'Concierge Downtown', department: 'Concierge', location: 'Downtown', regular_seconds: 10 * 3600, overtime_seconds: 5 * 3600 }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toContain('Stylist Uptown');
    expect(lines[2]).toContain('Concierge Downtown');
    expect(lines[2]).toContain(',10,5,0');
  });
  it('sanitizes an injected name', () => {
    expect(buildPayrollCsv([row({ employee_name: '=HYPERLINK("http://evil")' })])).toContain("'=HYPERLINK");
  });
  it('writes one dollar column per Gusto earning, cents when present, blank otherwise', () => {
    const csv = buildPayrollCsv([
      row({ extras: { 'Paycheck Tips': 135.75, 'Team Stylist Development': 850, 'Paid Time': 2295 } }),
      row({ employee_name: 'Jordan Demo' }),
    ]);
    const [header, withExtras, without] = csv.split('\r\n');
    // Fixed header set: all earning columns present even when unused, so Gusto's
    // remembered Smart Import mapping never shifts between runs.
    expect(header).toContain('Paycheck Tips,Commission,Bonus,Paid Time,Missed Punch,Guest Experience Bonus,Team Stylist Development');
    expect(header).toContain('Cash Tips,Exceptions');
    const cols = withExtras.split(',');
    const headerCols = header.split(',');
    expect(cols[headerCols.indexOf('Paycheck Tips')]).toBe('135.75');
    expect(cols[headerCols.indexOf('Team Stylist Development')]).toBe('850.00');
    expect(cols[headerCols.indexOf('Paid Time')]).toBe('2295.00');
    expect(cols[headerCols.indexOf('Commission')]).toBe('');
    expect(without.split(',')[headerCols.indexOf('Paycheck Tips')]).toBe('');
  });
});
