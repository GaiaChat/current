import { describe, expect, it } from 'vitest';
import { buildGatewayUrl } from './useGateway';

function locationLike(href: string): Location {
  return new URL(href) as unknown as Location;
}

describe('buildGatewayUrl', () => {
  it('uses ws for HTTP servers', () => {
    expect(buildGatewayUrl(42, locationLike('http://egg.hotandsteamysoup.com:6414/channels/general'))).toBe(
      'ws://egg.hotandsteamysoup.com:6414/gateway?lastEventSeq=42',
    );
  });

  it('uses wss for HTTPS servers', () => {
    expect(buildGatewayUrl(7, locationLike('https://chat.example.com/channels/general'))).toBe(
      'wss://chat.example.com/gateway?lastEventSeq=7',
    );
  });
});
