"""Score fusion and ID detection are pure functions, so the ranking rules are pinned without a database."""

import pytest

from app.search.hybrid import ID_MATCH_SCORE, Hit, best_per_policy, fuse, policy_ids_in


def hit(policy_id: str, score: float = 1.0, excerpt: str = "") -> Hit:
    number = policy_id.split("-")[0].lower()
    return Hit(policy_id, f"{policy_id} title", "v1", f"{number}.md", excerpt or f"{policy_id} text", score)


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("EMAIL-01", ["EMAIL-01"]),
        ("email-01 and Late-01, then EMAIL-01 again", ["EMAIL-01", "LATE-01"]),
        ("late-shipment refund", []),
        ("EMAIL01, EMAIL 01 or EMAIL-01x", []),
        ("(REVIEW-01).", ["REVIEW-01"]),
    ],
)
def test_policy_ids_are_found_case_insensitively_without_repeats(query: str, expected: list[str]) -> None:
    assert policy_ids_in(query) == expected


def test_best_paragraph_represents_its_policy_with_its_own_score() -> None:
    hits = [hit("DUP-01", 0.9, "best"), hit("LATE-01", 0.8), hit("DUP-01", 0.7, "worse"), hit("SHIP-01", 0.6)]

    best = best_per_policy(hits)

    assert [(item.policy_id, item.score) for item in best] == [("DUP-01", 0.9), ("LATE-01", 0.8), ("SHIP-01", 0.6)]
    assert best[0].excerpt == "best"


def test_no_signal_means_no_matches() -> None:
    assert fuse([], [], []) == []


def test_keyword_only_match_scores_half_its_coverage() -> None:
    [match] = fuse([], [hit("AMOUNT-01", 0.5, excerpt="Apply a cap of USD 100.")], [])

    assert match == {
        "id": "AMOUNT-01",
        "title": "AMOUNT-01 title",
        "version": "v1",
        "file": "amount.md",
        "excerpt": "Apply a cap of USD 100.",
        "relevance_score": 0.25,
        "matched_by": ["keyword"],
        "similarity": None,
    }


def test_semantic_only_match_reports_its_similarity() -> None:
    [match] = fuse([], [], [hit("EMAIL-01", 0.7083)])

    assert match["matched_by"] == ["semantic"]
    assert match["similarity"] == 0.71
    assert match["relevance_score"] == round(0.7083 / 2, 4)


def test_a_clear_keyword_lead_beats_a_nearly_flat_meaning_lead() -> None:
    # The real-model numbers for "late shipment refund": AMOUNT-01 has all three words in its title.
    keyword = [hit("AMOUNT-01", 9 / 9), hit("LATE-01", 6 / 9), hit("EXCLUDE-01", 5 / 9)]
    meaning = [hit("EXCLUDE-01", 0.792), hit("LATE-01", 0.722), hit("AMOUNT-01", 0.631)]

    matches = fuse([], keyword, meaning)

    assert [match["id"] for match in matches] == ["AMOUNT-01", "LATE-01", "EXCLUDE-01"]
    assert matches[0]["matched_by"] == ["keyword", "semantic"]
    assert matches[0]["relevance_score"] == round((1 + 0.631) / 2, 4)


def test_meaning_decides_between_equal_keyword_coverage() -> None:
    # "can we refund an order twice?": both policies contain "refund" (in the title) and "order".
    keyword = [hit("PARTIAL-01", 4 / 9), hit("DUP-01", 4 / 9)]
    meaning = [hit("DUP-01", 0.768), hit("PARTIAL-01", 0.726)]

    assert [match["id"] for match in fuse([], keyword, meaning)] == ["DUP-01", "PARTIAL-01"]


def test_a_policy_named_by_id_always_ranks_first() -> None:
    near_perfect = hit("DUP-01", 0.99)

    matches = fuse([hit("REVIEW-01", excerpt="first paragraph")], [near_perfect], [near_perfect])

    assert [match["id"] for match in matches] == ["REVIEW-01", "DUP-01"]
    assert matches[0]["matched_by"] == ["id"]
    assert matches[0]["relevance_score"] == ID_MATCH_SCORE > matches[1]["relevance_score"]
    assert matches[0]["excerpt"] == "first paragraph"


def test_matched_by_is_always_ordered_id_keyword_semantic() -> None:
    policy = "EMAIL-01"

    [match] = fuse([hit(policy)], [hit(policy, 0.5)], [hit(policy, 0.62)])

    assert match["matched_by"] == ["id", "keyword", "semantic"]
    assert match["relevance_score"] == round(ID_MATCH_SCORE + (0.5 + 0.62) / 2, 4)


def test_excerpt_prefers_keyword_then_meaning_then_first_paragraph() -> None:
    by_id = [hit("A-01", excerpt="first A"), hit("B-01", excerpt="first B"), hit("C-01", excerpt="first C")]
    by_keyword = [hit("A-01", excerpt="keyword A")]
    by_meaning = [hit("A-01", 0.8, excerpt="meaning A"), hit("B-01", 0.7, excerpt="meaning B")]

    excerpts = {match["id"]: match["excerpt"] for match in fuse(by_id, by_keyword, by_meaning)}

    assert excerpts == {"A-01": "keyword A", "B-01": "meaning B", "C-01": "first C"}


def test_equal_scores_are_ordered_by_file_name() -> None:
    tied = [hit("REVIEW-01", 0.5), hit("DUP-01", 0.5), hit("EMAIL-01", 0.5)]

    matches = fuse([], tied, [])

    assert [match["file"] for match in matches] == ["dup.md", "email.md", "review.md"]
    assert len({match["relevance_score"] for match in matches}) == 1
