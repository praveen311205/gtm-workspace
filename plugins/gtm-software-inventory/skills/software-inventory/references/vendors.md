# Known vendors

Seed list for discovery (step 1), "Used for" defaults and overlap categories. Sender domains are a starting point: many vendors bill through Stripe or Paddle, so also search by name. Add a row whenever the scan finds a new tool.

| Tool | Search terms / sender domains | Category | Default "Used for" |
|---|---|---|---|
| Claude (Anthropic) | anthropic.com, claude.com, mail.anthropic.com, "Anthropic, PBC" | AI assistant | Team AI workspace for research, write-ups, outreach drafting, docs and agents |
| Google Workspace | google.com (payments-noreply), "Google Workspace" invoice | Email & productivity | Company email, calendar, Drive, Docs, Meet; Gemini meeting notes |
| Slack | slack.com, "Slack receipt" | Internal comms | Team and client chat (shared channels / group DMs) |
| Metaview | metaview.ai | Meeting/interview notes | AI notes and transcripts for candidate and client calls |
| Loxo | loxo.co | ATS / recruiting CRM | Candidate database, pipeline and client job tracking |
| LinkedIn | linkedin.com, "LinkedIn receipt", Recruiter, Sales Navigator, Premium | Sourcing / prospecting | Candidate sourcing (Recruiter/Premium), client prospecting, job posts |
| lemlist | lemlist.com | Outbound sequencing | Cold email (and LinkedIn) outreach sequences to candidates and clients |
| Zapmail | zapmail.ai | Email infrastructure | Extra sending domains and mailboxes for outbound (feeds lemlist) |
| Clay | clay.com, clay.run | Data enrichment | Lead/candidate list building and enrichment (emails, firmographics) |
| Lovable | lovable.dev | App builder | Building internal tools and web pages |
| Canva | canva.com | Design | LinkedIn post graphics, decks, brand assets |
| Pin | pin.com | AI sourcing | AI candidate search and automated outreach |
| Juicebox | juicebox.ai, juicebox.work, PeopleGPT | AI sourcing | AI people search across the open web for candidates |
| Signalbase | "Signalbase" (search by name) | Intent / signals | Hiring and company signals for client prospecting (confirm with team) |
| Adobe eSign | adobe.com, "Acrobat Sign" | E-signature | Sending client T&Cs and contracts for signature |
| Revolut | revolut.com, "Revolut Business" plan fee | Banking | Business bank account and cards (plan fee is the subscription) |
| Odido | odido.nl | Telecom | Business mobile line/data |
| cal.com | cal.com | Scheduling | Booking links ("Book a Meeting" in email signature) |
| WeWork | wework.com | Workspace | Office / coworking membership |
| ChatGPT (OpenAI) | openai.com, "ChatGPT Plus" | AI assistant | General AI assistant (check whether still used next to Claude) |
| SalesQL | salesql.com | Data enrichment | Contact emails/phones from LinkedIn profiles (credits for lemlist) |
| Spott | spott.io | Recruiting software | New in Nov 2026 (welcome email to Praveen); confirm what it is used for |
| Tellow | tellow.nl | Bookkeeping | Accounting software (check whether still used alongside the accountant) |
| Folk | folk.app | ATS / recruiting CRM | Earlier CRM; likely replaced by Loxo - check for cancellation |
| Lusha | lusha.com | Data enrichment | Contact data; listed in GTM Financial.xlsx - check if still active |
| Wix | wix.com | Website | Website subscription; listed in GTM Financial.xlsx - check if still active |
| Fiverr | fiverr.com | Freelancers | One-off website/design work (not a subscription) |
| Notion | notion.so | Notes / docs | Listed in GTM Financial.xlsx at €0 - check if paid |
| exali | exali.com | Insurance | Professional indemnity insurance (yearly) |

## Overlap map

Use these when filling "Overlaps with". Confirm against what the team actually uses each tool for.

| Category / job | Tools | Default note |
|---|---|---|
| Candidate sourcing & search | LinkedIn, Juicebox, Pin, Clay, Loxo (built-in sourcing) | **Likely duplication.** Three to four paid tools find people. Check which one the team actually sources from. |
| Outreach automation | lemlist, Pin (outreach), Loxo (sequences), LinkedIn InMail | Partial duplication. Pin and Loxo sequences may overlap with lemlist. |
| Data enrichment / contact finding | Clay, lemlist (finder), Juicebox (contact data), Signalbase, SalesQL, Lusha | Partial duplication. |
| Prospecting signals | Signalbase, Clay (signals), LinkedIn Sales Navigator | Partial duplication. |
| AI assistant | Claude, ChatGPT | **Likely duplication.** Check who still uses ChatGPT. |
| CRM / ATS | Loxo, Folk, Spott | **Duplication if Folk is still billed.** Folk should be cancelled after the move to Loxo. |
| Meeting notes / transcription | Metaview, Google Workspace (Gemini notes) | **Duplication.** Both currently take notes on the same calls. |
| E-signature | Adobe eSign, Google Workspace (Docs eSignature, on eligible plans) | Possible duplication. Depends on the Workspace edition. |
| Scheduling | cal.com, Google Calendar appointment schedules | Possible duplication. Depends on the Workspace edition. |
| Internal chat | Slack, Google Chat (included in Workspace) | Complementary in practice, since clients are on Slack. |
| Building tools & pages | Lovable, Claude (artifacts / Claude Code) | Partial duplication. |
| Design | Canva, Claude (design artifacts) | Mostly complementary. |
| Email infrastructure | Zapmail, Google Workspace mailboxes | Complementary: separate sending domains protect the main domain. |
