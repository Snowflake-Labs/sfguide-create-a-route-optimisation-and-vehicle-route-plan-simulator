"""One way to open a Snowflake session from the installer's Python helpers.

snowflake-connector-python 5.x (what a fresh .venv resolves to) warns twice
per process unless the caller is explicit: a FutureWarning when
`enable_server_session_keep_alive_auto_detection` is left unset, and another at
exit when a connection was never closed. Four helpers each called
`snowflake.connector.connect()` directly, so every install printed both into
its console. This module sets the option only when the installed connector
knows it (older 3.x/4.x flag unknown parameters instead) and closes every
connection it opened at exit.

    from sf_connect import connect
    con = connect("my_connection", session_parameters={...})
"""
from __future__ import annotations

import atexit
import dataclasses

_OPEN = []


def _supports(field: str) -> bool:
    try:
        from snowflake.connector.connection_config import ConnectionConfig
    except ImportError:
        return False
    try:
        return any(f.name == field for f in dataclasses.fields(ConnectionConfig))
    except TypeError:
        return hasattr(ConnectionConfig, field)


KEEP_ALIVE = "enable_server_session_keep_alive_auto_detection"
# The connector registers its own atexit hook per connection, AFTER ours
# (import time), so LIFO runs it first and it warns before we close. Turning
# it off hands exit-time closing to _close_all below.
AUTO_CLEANUP = "auto_cleanup"


def connect(connection_name: str, **kwargs):
    import snowflake.connector

    # False = always log out on close. These helpers never leave async queries
    # running, so there is nothing for the server to keep alive.
    if _supports(KEEP_ALIVE):
        kwargs.setdefault(KEEP_ALIVE, False)
    if _supports(AUTO_CLEANUP):
        kwargs.setdefault(AUTO_CLEANUP, False)
    con = snowflake.connector.connect(connection_name=connection_name, **kwargs)
    _OPEN.append(con)
    return con


@atexit.register
def _close_all():
    while _OPEN:
        con = _OPEN.pop()
        try:
            con.close()
        except Exception:  # noqa: BLE001 - closing at exit must never raise
            pass
