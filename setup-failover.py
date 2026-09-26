#!/usr/bin/env python3
"""Materialize the failover provider into ZCode's v2 provider store.

The desktop app ignores the legacy `provider` section of
~/.zcode/cli/config.json (that import path belongs to the standalone CLI).
Its real source of truth is ~/.zcode/v2/provider_config.json, which it
polls and hot-reloads. This script injects the failover router provider
(http://127.0.0.1:4490/v1) there idempotently, preserving all other rules
untouched. Run once per machine after cloning the ~/.zcode repo.
"""

import json
import os

STORE = os.path.expanduser("~/.zcode/v2/provider_config.json")

ROLE_MODELS = [
    "security-auditor",
    "performance-auditor",
    "architecture-auditor",
    "audit-critic",
    "implementer",
    "pcb-creator",
    "pcb-designer",
    "pcb-emc-auditor",
    "pcb-schematic-auditor",
    "pcb-spice-auditor",
]

FAILOVER_RULE = {
    "providerId": "failover",
    "providerName": "Failover",
    "config": {
        "group": "standard-personal",
        "access": {"type": "api-key", "apiKey": "failover-local"},
        "api": {"type": "openai-chat-completions", "baseUrl": "http://127.0.0.1:4490/v1"},
        "personalModelIds": ROLE_MODELS,
        "modelOrder": ROLE_MODELS,
    },
}


def main() -> None:
    with open(STORE) as f:
        store = json.load(f)
    config = store["config"]

    rules = config["providerConfigRules"]["providerRules"]
    if not any(r.get("providerId") == "failover" for r in rules):
        rules.append(FAILOVER_RULE)

    if "failover" not in config.get("providerOrder", []):
        config["providerOrder"] = config.get("providerOrder", []) + ["failover"]

    with open(STORE, "w") as f:
        json.dump(store, f, indent=2)
    print("failover provider present:", [r["providerId"] for r in rules])


if __name__ == "__main__":
    main()
