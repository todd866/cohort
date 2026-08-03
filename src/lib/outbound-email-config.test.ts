import { describe, expect, it } from 'vitest';
import { getOutboundEmailConfig } from './outbound-email-config';

describe('getOutboundEmailConfig', () => {
  it('requires both an API key and an operator-owned sender', () => {
    expect(getOutboundEmailConfig({})).toBeNull();
    expect(getOutboundEmailConfig({ RESEND_API_KEY: 're_test' })).toBeNull();
    expect(getOutboundEmailConfig({ EMAIL_FROM: 'Study <mail@example.org>' })).toBeNull();
  });

  it('rejects whitespace-only values', () => {
    expect(getOutboundEmailConfig({
      RESEND_API_KEY: '  ',
      EMAIL_FROM: '\n',
    })).toBeNull();
  });

  it('returns trimmed, explicitly configured values', () => {
    expect(getOutboundEmailConfig({
      RESEND_API_KEY: ' re_test ',
      EMAIL_FROM: ' Study <mail@example.org> ',
    })).toEqual({
      apiKey: 're_test',
      from: 'Study <mail@example.org>',
    });
  });
});
