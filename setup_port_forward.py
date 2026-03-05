#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["asusrouter", "aiohttp"]
# ///
"""Set up port forwarding on ASUS router for claude-code-monitor."""

import asyncio
import aiohttp
from asusrouter import AsusRouter, AsusData
from asusrouter.modules.port_forwarding import (
    PortForwardingRule,
    AsusPortForwarding,
)


async def main():
    session = aiohttp.ClientSession()
    router = AsusRouter(
        hostname="192.168.50.1",
        username="xiangpan",
        password="990123",
        use_ssl=True,
        session=session,
    )

    try:
        await router.async_connect()
        print("[router] Connected to ASUS router at 192.168.50.1")

        # Show current rules
        data = await router.async_get_data(AsusData.PORT_FORWARDING)
        current_rules = data.get("rules", [])
        print(f"[router] Current port forwarding rules: {len(current_rules)}")
        for r in current_rules:
            print(f"  - {r.name}: :{r.port_external} -> {r.ip_address}:{r.port} ({r.protocol})")

        # Add rule for claude-code-monitor
        rule = PortForwardingRule(
            name="claude-code-monitor",
            ip_address="192.168.50.9",
            port="3456",
            protocol="TCP",
            ip_external="",
            port_external="3456",
        )

        print(f"\n[router] Adding rule: :3456 -> 192.168.50.9:3456 (TCP)")
        await router.async_set_port_forwarding_rules(rule)

        # Ensure port forwarding is enabled
        await router.async_set_state(AsusPortForwarding.ON)

        print("[router] Port forwarding rule added and enabled!")
        print(f"\n  Dashboard is now accessible at http://<your-public-ip>:3456")
        print(f"  Find your public IP: curl -s ifconfig.me\n")

    except Exception as e:
        print(f"[router] Error: {e}")
        raise
    finally:
        await router.async_disconnect()
        await session.close()


asyncio.run(main())
