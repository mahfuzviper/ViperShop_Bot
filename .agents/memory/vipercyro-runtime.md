---
name: ViperCryo runtime
description: Deployment constraints discovered while bringing the Discord bot online.
---

The Discord service shares an artifact-prefixed HTTP route, so health handlers must accept both local paths and the `/api` proxy prefix. Discord Message Content is privileged and should only be requested when explicitly enabled with `ENABLE_MESSAGE_CONTENT=true` (or an AI channel/trigger is configured).

**Why:** Replit's proxy forwards the artifact prefix to the service, while Discord rejects login when Message Content is requested without portal approval.

**How to apply:** Preserve the dual health routes and conditional intent selection when extending the bot runtime.