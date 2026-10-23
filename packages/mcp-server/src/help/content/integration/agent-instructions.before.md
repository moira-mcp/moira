---
title: Agent Instructions
description: System instructions for AI agents working with MCP Moira
sidebar:
  order: 3
---

This page describes system instructions automatically provided to AI agents when they connect to MCP Moira server.

## How Instructions Are Delivered

MCP Moira delivers instructions through the MCP `instructions` field during server initialization.

Tool descriptions, including agent/model variants, are static catalog data. They never include the
runtime system prompt and cannot be overridden through global settings.

OAuth and API-token clients accept the current static catalog during MCP `initialize`. If an
ordinary request returns HTTP 426 with `upgrade_required`, reconnect with the same valid credential
so the client initializes again. Automatic OAuth refresh may rotate the access token and preserves
the predecessor's catalog state; catalog refresh itself does not require token rotation.

## Source of Truth

The checked-in default is `config/prompts/systemPrompt.md`. Startup migration stores it in the
runtime settings database, where administrators may manage supported agent/model prompt overrides.
The content below is the checked-in default reference, not a live view of an installation's setting.

The default source is:

- seeded into the runtime setting used for the MCP `instructions` field;
- imported directly by the English documentation page and the default portable help reader.

The Russian documentation page retains a translation. Public portable `agent-instructions` help shows the canonical English default; it has no language parameter or Russian topic-prefix selector. Neither reference substitutes for the effective DB-backed instructions returned by a particular server during initialization.

---

## Full System Prompt
