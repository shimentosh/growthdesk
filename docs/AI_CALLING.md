# AI calling

An AI voice agent phones a contact, talks from a script the workspace wrote, and the call comes back into the CRM: a transcript, a summary, an outcome, and the follow-ups that outcome calls for. The voice agent is a [Cartesia Managed Agent](https://docs.cartesia.ai/agents/introduction); Growthdesk owns the script, the rules and the results.

Code: `apps/api/src/ai-calling`, `packages/shared/src/ai-calling.ts`, the `ai_call` step in `apps/api/src/campaigns/engine.service.ts`. Web: Calling → AI agents, Settings → Calling, the AI calling campaign type.

## Setting it up

1. **Settings → Calling → AI calling**: paste a Cartesia API key (play.cartesia.ai/keys). The key is checked, the account's phone numbers are listed, and a webhook is registered at `${PUBLIC_APP_URL}/api/webhooks/cartesia/<key>`. Choose the number calls go out from, and the calling window.
2. **Calling → AI agents → New agent**: start from a template (speed-to-lead, appointment setter, missed-meeting recovery, re-engagement, event follow-up, customer check-in), pick a voice, fill in *About* with your own facts, and **Test call** your phone.
3. **Campaigns → New campaign → AI calling**: choose the agent and a flow (one call; call and retry next day if unanswered; call then email). Choose the audience and launch. For speed to lead, turn on *Always on* and use the workflow template “Speed to lead: AI agent calls within minutes”.

Without a public https `PUBLIC_APP_URL` (local development) Cartesia cannot post back; the worker's sweep fetches each call's result from Cartesia every minute instead.

## Rules every AI call goes through

These are checked immediately before Cartesia is asked to dial, for campaign steps, the “AI call” button and workflows alike (`AiCallsService.dial`):

| Rule | When it fails |
| - | - |
| Consent recorded as granted (`Contact.consentStatus`) | the step is skipped, the sequence goes on |
| A phone number in international format | skipped |
| Not marked do not contact, not on the do-not-contact list | the enrollment stops |
| Inside the calling window **in the contact's own time zone** (never wider than 08:00–21:00) | the step waits until the window opens |
| Not AI-called in the last *n* hours (default 20) | the step waits |
| Plan includes calling, account not restricted, outreach not paused | the step waits |

Every agent's opening line ends with a disclosure that must say it is an AI, and every prompt tells the agent to treat “stop calling me” as an opt-out. These exist because AI-voice calls need prior consent in the US (TCPA, as the FCC ruled in 2024), the UK (PECR) and the EU (ePrivacy). Recording consent rules, national do-not-call registries (US DNC, UK TPS) and caller-ID rules remain the workspace's responsibility.

A test call skips consent and hours (the person ticks that the number is theirs or its owner agreed) but never the do-not-contact list.

## What happens after a call

1. Cartesia posts `call_started`, `call_completed` / `call_failed` and `post_call_analysis` (secret in `X-Webhook-Secret`). The status, end reason, transcript and summary are stored, and a `result` job is queued on the `calls` queue.
2. The result (once per call, `Call.processedAt`): the end reason decides *no answer*, *busy* and *voicemail*. A conversation is judged from its transcript by the AI model (one AI credit, `call_analysis`) or, without one, by keyword rules: outcome, interest (hot/warm/cold), callback time, agreed meeting time, next step, and answers to the qualifying questions.
3. Then, in one transaction:
   - *Do not call*: the number goes on the do-not-contact list.
   - *Callback requested* (with a time): a call task for the contact's owner.
   - *Meeting booked*: a task to confirm it, and the owner is notified.
   - *Hot interest*: a follow-up task.
   - The enrollment stops on *meeting booked*, *not interested*, *do not call* and *wrong number*.
   - The call settles: a timeline entry (attributed to the AI agent, on behalf of the owner) and `call.completed`, which workflows can trigger on.

A branch step can read `call_outcome`: the latest AI call's outcome in that enrollment (`pending` while it is still being judged, `failed` when it never connected).

## Testing

`apps/api/test/ai-calling.e2e-spec.ts` runs the whole flow against a fake Cartesia (`CARTESIA_API_URL`, tests only). Pure rules: `packages/shared/test/ai-calling.test.ts`, `apps/api/src/ai-calling/ai-calling.spec.ts`.
