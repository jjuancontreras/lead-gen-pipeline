'use strict';
/* ---- vocabulary --------------------------------------------------------- */

/** The pipeline, in order. Drives the per-row status badge and its hint. */
export const STATUSES = [
  { key:'sourced',      label:'Sourced',      group:'intake',   color:'#6b7688', hint:'Pulled from OSM. Not shown in the inbox — qualify them with a campaign run first.' },
  { key:'shortlisted',  label:'Shortlisted',  group:'intake',   color:'#8b96a8', hint:'Passed the SME filter and is worth verifying.' },
  { key:'needs_manual', label:'Needs manual', group:'intake',   color:'#f0b429', hint:'Automated verification could not resolve it. Open it in a browser and decide.' },
  { key:'verified',     label:'Verified',     group:'qualified',color:'#7cb0ff', hint:'Web presence confirmed. Ready for a first touch.' },
  { key:'demo_queued',  label:'Demo queued',  group:'delivery', color:'#8fd6c2', hint:'You picked it for a full demo. Build demo in the Work Queue scaffolds it.' },
  { key:'scaffolded',   label:'Scaffolded',   group:'delivery', color:'#8fd6c2', hint:'Demo folder exists. Build it with /demo-site-build, deploy, then Mark built.' },
  { key:'drafted',      label:'Drafted',      group:'outreach', color:'#f0b429', hint:'A draft exists and nobody has pressed Send. Send it, then run `npm run sent`.' },
  { key:'tier1_sent',   label:'First touch',  group:'outreach', color:'#7cb0ff', hint:'Opening message sent. The 3/7/14 follow-up clock is running.' },
  { key:'replied',      label:'Replied',      group:'outreach', color:'#4fd1a5', hint:'They answered. Highest priority in the inbox.' },
  { key:'demo_built',   label:'Demo built',   group:'delivery', color:'#b39bfa', hint:'Deployed. Record the walkthrough, then send the pitch.' },
  { key:'demo_sent',    label:'Demo sent',    group:'delivery', color:'#b39bfa', hint:'Demo link is with the prospect.' },
  { key:'meeting',      label:'Meeting',      group:'delivery', color:'#b39bfa', hint:'A call or visit is booked.' },
  { key:'won',          label:'Won',          group:'closed',   color:'#4fd1a5', hint:'Signed.' },
  { key:'lost',         label:'Lost',         group:'closed',   color:'#f87171', hint:'Closed out, no deal.' },
  { key:'nurture',      label:'Nurture',      group:'closed',   color:'#8b96a8', hint:'Parked. Worth another look later.' },
  { key:'disqualified', label:'Disqualified', group:'closed',   color:'#5c6675', hint:'Not an SME fit — never contact.' },
];
const STATUS_BY = Object.fromEntries(STATUSES.map((s, i) => [s.key, { ...s, order: i }]));
export const statusMeta = (k) => STATUS_BY[k] || { key:k, label:k || 'unknown', color:'#5c6675', order:99, hint:'' };

/**
 * The main nav, reduced from 14 raw pipeline statuses to the handful of
 * things a human actually needs to act on. `statuses: null` on 'all' means
 * no status filter beyond the inbox's own exclusion of `sourced`. The raw
 * status is never hidden - it still shows as the badge on every row and in
 * the detail panel - this only changes what you click to get there.
 */
export const VIEWS = [
  { key:'all', label:'All', hint:'Every contact in this campaign.', statuses:null },
  { key:'replied', label:'Replied', hint:'They answered. Highest priority - reply to them.', statuses:['replied'] },
  { key:'needs_manual', label:'Needs manual', hint:'Automated verification could not resolve it. Open it and decide.', statuses:['needs_manual'] },
  { key:'drafted', label:'Drafted', hint:'A message is written and waiting for you to send it.', statuses:['drafted'] },
  { key:'ready', label:'Ready to reach out', hint:'Qualified. Nobody has messaged them yet.', statuses:['verified'] },
  { key:'sent', label:'Sent', hint:'First message sent. Waiting on a reply or the next follow-up date.', statuses:['tier1_sent'] },
  { key:'in_progress', label:'In progress', hint:'A demo is queued, being built, sent, or a meeting is booked.', statuses:['demo_queued','scaffolded','demo_built','demo_sent','meeting'] },
  { key:'closed', label:'Closed', hint:'Won, lost, parked, or disqualified.', statuses:['won','lost','nurture','disqualified'] },
];
export const VIEW_BY = Object.fromEntries(VIEWS.map((v) => [v.key, v]));

/**
 * Web presence, read as an opportunity signal rather than a neutral field.
 * A business whose only reachable presence is a Facebook page already has an
 * audience and nowhere to send it — that is the best possible prospect here,
 * so it ranks above "no presence at all".
 */
const PRESENCE = {
  facebook:     { rank:5, band:'prime',   label:'Facebook only',    say:'Has an audience on Facebook and nowhere to send it. Best possible prospect.' },
  instagram:    { rank:4, band:'strong',  label:'Instagram only',   say:'Runs on Instagram alone — no site to link in bio.' },
  tiktok:       { rank:4, band:'strong',  label:'TikTok only',      say:'TikTok presence only, nothing to convert on.' },
  none:         { rank:4, band:'strong',  label:'No web presence',  say:'Nothing online at all. Whole presence is greenfield.' },
  linktree:     { rank:3, band:'warm',    label:'Link-in-bio only', say:'A link hub standing in for a website.' },
  free_host:    { rank:3, band:'warm',    label:'Free host page',   say:'A free-host page — replaceable with something real.' },
  delivery_app: { rank:2, band:'warm',    label:'Delivery app only',say:'Only reachable through a delivery marketplace, on their terms.' },
  marketplace:  { rank:2, band:'warm',    label:'Marketplace only', say:'Listed on a marketplace, no presence of its own.' },
  standalone:   { rank:0, band:'cold',    label:'Has own site',     say:'Already has a standalone site. Low priority.' },
};
const UNKNOWN_PRESENCE = { rank:1, band:'unknown', label:'Unverified', say:'Verification has not run on this lead yet.' };
export const presenceMeta = (k) => PRESENCE[k] || UNKNOWN_PRESENCE;

/** Classify one `notes` fragment so the scoring reason reads as a signal. */
export function reasonTone(text) {
  const t = text.toLowerCase();
  if (/no web presence|only presence is|nowhere to send|growing, has budget|phone available|email available/.test(t)) return 'good';
  if (/below sme floor|could not resolve|ambiguous|chain|failed|suppress|do not contact/.test(t)) return 'warn';
  return '';
}
export const splitNotes = (notes) =>
  String(notes || '').split(';').map((s) => s.trim()).filter(Boolean);
