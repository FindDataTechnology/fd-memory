import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # python/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class FakeTransport:
    """记录每次投递的 transport 缝（不打真网）。"""

    def __init__(self, status: int = 200, raises: BaseException | None = None):
        self.status = status
        self.raises = raises
        self.calls = []

    def __call__(self, url, body, headers, timeout):
        self.calls.append(
            {
                "url": url,
                "payload": json.loads(body.decode("utf-8")),
                "headers": dict(headers),
                "timeout": timeout,
            }
        )
        if self.raises is not None:
            raise self.raises
        return self.status

    @property
    def last(self):
        return self.calls[-1]


@pytest.fixture
def transport():
    return FakeTransport()


@pytest.fixture
def observer(transport):
    from yongyi_agent.observe import Observer

    return Observer("http://127.0.0.1:49375", "test-token", harness="pytest", transport=transport, synchronous=True)
