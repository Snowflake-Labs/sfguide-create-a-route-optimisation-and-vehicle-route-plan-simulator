// Partner trust + payment + KYC + blacklist block (Phase B).

import type { Offer } from '../types';

export default function PartnerPanel({ offer }: { offer: Offer }) {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>Partner</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <div><b>Name:</b> {offer.PARTNER_NAME || '—'}</div>
        <div><b>Country:</b> {offer.PARTNER_COUNTRY || '—'}</div>
        <div><b>Credit:</b> {offer.PARTNER_CREDIT_SCORE != null ? `${offer.PARTNER_CREDIT_SCORE}/100` : '—'}</div>
        <div><b>Payment:</b> {offer.PARTNER_PAYMENT_DAYS != null ? `${offer.PARTNER_PAYMENT_DAYS}d` : '—'}</div>
        <div><b>KYC:</b> {offer.PARTNER_KYC || '—'}</div>
        <div><b>Blacklist:</b> {offer.PARTNER_BLACKLIST ? 'YES' : 'no'}</div>
      </div>
    </div>
  );
}
