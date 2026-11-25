"""Failed sign-ins are counted per email and across all emails over a sliding window (with a fake clock)."""

from app.auth.throttle import LoginThrottle

ALEX = "alex@opspilot.test"
SAM = "sam@opspilot.test"


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_an_email_is_blocked_after_max_failures_until_the_oldest_leaves_the_window() -> None:
    clock = FakeClock()
    throttle = LoginThrottle(max_failures=3, window_seconds=60, clock=clock)
    for _ in range(3):
        assert throttle.retry_after(ALEX) is None
        throttle.record_failure(ALEX)
        clock.advance(10)
    # Failures at 1000, 1010 and 1020; it is now 1030 and the first one leaves the window at 1060.
    assert throttle.retry_after(ALEX) == 30
    clock.advance(29.5)
    assert throttle.retry_after(ALEX) == 1  # rounded up, never 0
    clock.advance(0.5)
    assert throttle.retry_after(ALEX) is None


def test_emails_are_counted_separately_and_reset_clears_only_one() -> None:
    clock = FakeClock()
    throttle = LoginThrottle(max_failures=2, window_seconds=900, clock=clock)
    for _ in range(2):
        throttle.record_failure(ALEX)
        throttle.record_failure(SAM)
    assert throttle.retry_after(ALEX) == 900
    assert throttle.retry_after(SAM) == 900
    assert throttle.retry_after("other@opspilot.test") is None
    throttle.reset(ALEX)
    assert throttle.retry_after(ALEX) is None
    assert throttle.retry_after(SAM) == 900


def test_the_global_cap_counts_failures_across_all_emails() -> None:
    clock = FakeClock()
    throttle = LoginThrottle(max_failures=5, window_seconds=900, global_max_failures=3, clock=clock)
    for index in range(3):
        throttle.record_failure(f"user{index}@opspilot.test")
        clock.advance(100)
    # No single email reached 5 failures, but together they reached the global cap of 3.
    assert throttle.retry_after("fresh@opspilot.test") == 900 - 300
    # A successful sign-in forgets that email's failures, so they stop counting towards the cap as well.
    throttle.reset("user0@opspilot.test")
    assert throttle.retry_after("fresh@opspilot.test") is None
    throttle.record_failure("user3@opspilot.test")  # failures now at 1100, 1200 and 1300
    assert throttle.retry_after("fresh@opspilot.test") == 1100 + 900 - 1300
    clock.advance(700)
    assert throttle.retry_after("fresh@opspilot.test") is None


def test_the_longer_of_the_two_waits_wins() -> None:
    clock = FakeClock()
    throttle = LoginThrottle(max_failures=2, window_seconds=100, global_max_failures=3, clock=clock)
    throttle.record_failure(SAM)  # t=1000
    clock.advance(20)
    throttle.record_failure(ALEX)  # t=1020
    clock.advance(20)
    throttle.record_failure(ALEX)  # t=1040
    # Everyone is free again at 1100 (Sam's failure leaves the window); Alex's own limit lasts until 1120.
    assert throttle.retry_after(ALEX) == 80
    assert throttle.retry_after(SAM) == 60
    clock.advance(60)
    assert throttle.retry_after(SAM) is None
    assert throttle.retry_after(ALEX) == 20
    clock.advance(20)
    assert throttle.retry_after(ALEX) is None


def test_expired_failures_are_forgotten() -> None:
    clock = FakeClock()
    throttle = LoginThrottle(max_failures=5, window_seconds=60, clock=clock)
    for index in range(10):
        throttle.record_failure(f"user{index}@opspilot.test")
    clock.advance(61)
    throttle.record_failure(ALEX)
    # Old keys are dropped when a new failure is recorded, so memory stays bounded by recent failures.
    assert throttle._failures == {ALEX: (1_061.0,)}
