"""Shared exceptions for tool wrappers."""


class ToolUnavailableError(Exception):
    """Raised when a tool cannot run because its API key is missing or invalid."""
