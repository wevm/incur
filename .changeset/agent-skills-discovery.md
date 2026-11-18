---
'incur': minor
---

Updated `cli.fetch` to serve the [Agent Skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc) v0.2.0 index at `/.well-known/agent-skills/index.json`, listing each skill's `SKILL.md` URL and `sha256:` digest, with skills at `/.well-known/agent-skills/{name}/SKILL.md`. The v0.1.0 index at `/.well-known/skills/index.json` stays for older clients. Added `Skill.discovery({ origin, skills })`, which builds the same index with WebCrypto so other servers, including Cloudflare Workers, can publish it.
