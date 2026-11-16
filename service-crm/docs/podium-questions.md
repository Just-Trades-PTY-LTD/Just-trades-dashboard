# Questions for Podium (ready to send)

Hi Podium team,

We're Just Trades (Adelaide, Australia). We'd like to connect our own in-house
CRM to Podium using your public API, **read-only**. We don't want to send
messages through the API or change any of our existing Podium settings,
automations or customer wording (including missed-call text-back). Could you
please help with the following?

**Access and cost**
1. Is API access (developer account + OAuth app authorised by our account)
   available on our current plan for an Australian account? Is there any
   additional cost?
2. What rate limits apply to our account?
3. Is the `read_phones` scope (the Calls API and call webhooks) generally
   available for Australian accounts? It isn't listed on the OAuth scopes page.
4. Can we restrict the app to read-only scopes only (`read_phones`,
   `read_messages`, `read_contacts`, `read_users`, `read_locations`) and still
   receive webhooks?

**Calls**
5. Does the `call.received` webhook fire in real time while the phone is
   ringing, or only after the call?
6. On a call, does `userUid` identify the staff member who answered, or the
   one who finished the call? If a call is transferred between staff, is that
   one call record or several, and can we see who it was transferred through?
7. Are outgoing calls made from Podium included in the Calls API, with the
   staff member and duration?
8. How are calls handled by Podium AI represented (`handledByAi`,
   `aiAbandoned`)? Do they ever show as "answered"?
9. Are call recordings (not only voicemail) or AI call summaries available
   through the API?
10. Calls that arrive through a call-tracking provider are excluded from the
    Calls API — does that include calls forwarded from Google Ads forwarding
    numbers to our Podium numbers?

**Messages, webchat and AI**
11. Is any Podium AI / AI Employee information available through the API —
    conversation summary, details the AI collected (name, phone, address, job
    description), or intent? What does `GET /v4/conversations/{uid}/lead_id`
    return?
12. Is there a supported link (URL) that opens a specific conversation in the
    Podium app, like `phoneDetailsUrl` does for calls?
13. For webchat leads, does `webchatUrl` include the full page address with
    query parameters (UTM tags, `gclid`)? Is any other source or marketing
    attribution captured?
14. Can an integration tell when a message was sent automatically (for example
    by missed-call text-back or the AI), as opposed to by a staff member?

**Data**
15. Can you confirm in writing that we may keep copies of our own Podium call,
    message and contact data in our own CRM (secured, for our business use
    only) under the API Terms, including after we stop using the API?
16. Can we export historical calls and conversations (for example the last 12
    months) through the API or an export?
17. Where is our data processed and stored (Australia or the US)?

Thank you,
Just Trades
