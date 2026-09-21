import os
import unittest

os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")

from core.config import Settings


def _settings(**kwargs) -> Settings:
    return Settings(secret_key="test-secret", server_url="https://scrob.example.com", **kwargs)


class CorsAllowOriginsTests(unittest.TestCase):
    def test_defaults_to_server_url(self) -> None:
        self.assertEqual(_settings().cors_allow_origins, ["https://scrob.example.com"])

    def test_blank_falls_back_to_server_url(self) -> None:
        self.assertEqual(_settings(cors_origins="  ,  ").cors_allow_origins, ["https://scrob.example.com"])

    def test_splits_and_strips_list(self) -> None:
        self.assertEqual(
            _settings(cors_origins="https://a.example.com, https://b.example.com").cors_allow_origins,
            ["https://a.example.com", "https://b.example.com"],
        )

    def test_wildcard_is_passed_through(self) -> None:
        self.assertEqual(_settings(cors_origins="*").cors_allow_origins, ["*"])


if __name__ == "__main__":
    unittest.main()
