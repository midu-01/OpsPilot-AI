"""The policy files are parsed into documents and paragraphs before anything reaches the database."""

import hashlib
import shutil
from pathlib import Path

import pytest

from app.search.corpus import POLICIES_DIR, POLICY_FILES, PolicyDocument, chunk_corpus, load_corpus

EXPECTED = [
    ("SHIP-01", "01-shipping-commitments.md"),
    ("LATE-01", "02-late-shipment-eligibility.md"),
    ("AMOUNT-01", "03-refund-amount.md"),
    ("EXCLUDE-01", "04-exclusions.md"),
    ("PARTIAL-01", "05-partial-refunds.md"),
    ("DUP-01", "06-duplicate-requests.md"),
    ("EMAIL-01", "07-email-drafts.md"),
    ("REVIEW-01", "08-escalation.md"),
]


@pytest.fixture
def corpus(tmp_path: Path) -> Path:
    """A writable copy of the bundled policies."""
    copy = tmp_path / "policies"
    shutil.copytree(POLICIES_DIR, copy)
    return copy


def test_bundled_corpus_has_eight_policies_with_exact_paragraphs() -> None:
    documents = load_corpus()

    assert [(document.id, document.file) for document in documents] == EXPECTED
    for document in documents:
        source = (POLICIES_DIR / document.file).read_text(encoding="utf-8")
        assert document.version == "v1"
        assert source.startswith(f"# {document.title}\n")
        assert document.paragraphs
        for paragraph in document.paragraphs:
            assert paragraph in source
            assert not paragraph.startswith(("#", "Policy "))


def test_chunks_are_one_per_paragraph_with_a_content_fingerprint() -> None:
    document = PolicyDocument("TEST-01", "Test policy", "v2", "test.md", ("First paragraph.", "Second paragraph."))

    chunks = chunk_corpus([document])

    assert [(chunk.chunk_index, chunk.content) for chunk in chunks] == [
        (0, "First paragraph."),
        (1, "Second paragraph."),
    ]
    assert {(chunk.policy_id, chunk.title, chunk.version, chunk.file) for chunk in chunks} == {
        ("TEST-01", "Test policy", "v2", "test.md")
    }
    assert chunks[1].content_sha256 == hashlib.sha256(b"Second paragraph.").hexdigest()


def test_bundled_corpus_makes_one_chunk_per_policy_paragraph() -> None:
    chunks = chunk_corpus(load_corpus())

    assert len(chunks) == sum(len(document.paragraphs) for document in load_corpus()) == 8
    assert len({(chunk.policy_id, chunk.chunk_index) for chunk in chunks}) == len(chunks)


def test_ignores_unbundled_files_and_keeps_extra_paragraphs(corpus: Path) -> None:
    (corpus / "other.md").write_text("# Extra\n\nPolicy OTHER-01 · v1\n\nUnlistedkeyword", encoding="utf-8")
    extra_paragraph = "Supplemental rounding example for a fractional adjustment."
    with (corpus / "03-refund-amount.md").open("a", encoding="utf-8") as source:
        source.write(f"\n{extra_paragraph}\n")

    documents = load_corpus(corpus)

    assert [document.file for document in documents] == list(POLICY_FILES)
    amount = next(document for document in documents if document.id == "AMOUNT-01")
    assert len(amount.paragraphs) == 2 and amount.paragraphs[1] == extra_paragraph


def test_refuses_symlink_in_place_of_bundled_source(corpus: Path, tmp_path: Path) -> None:
    filename = "04-exclusions.md"
    (corpus / filename).rename(tmp_path / filename)
    (corpus / filename).symlink_to(tmp_path / filename)

    with pytest.raises(ValueError, match="04-exclusions"):
        load_corpus(corpus)


def test_refuses_a_symlinked_policy_folder(corpus: Path, tmp_path: Path) -> None:
    link = tmp_path / "linked"
    link.symlink_to(corpus, target_is_directory=True)

    with pytest.raises(ValueError, match="Invalid bundled policy file"):
        load_corpus(link)


@pytest.mark.parametrize(
    ("text", "problem"),
    [
        ("Shipping commitments\n\nPolicy SHIP-01 · v1\n\nParagraph.", "Invalid policy document"),
        ("# Shipping commitments\n\nPolicy SHIP-01 · v1", "Invalid policy document"),
        ("# Shipping commitments\n\nPolicy SHIP-01\n\nParagraph.", "Invalid policy metadata"),
        ("# Shipping commitments\n\nPolicy ship-01 · v1\n\nParagraph.", "Invalid policy metadata"),
    ],
)
def test_rejects_malformed_policy_files_naming_the_file(corpus: Path, text: str, problem: str) -> None:
    (corpus / "01-shipping-commitments.md").write_text(text, encoding="utf-8")

    with pytest.raises(ValueError, match=f"{problem}: 01-shipping-commitments.md"):
        load_corpus(corpus)


def test_rejects_two_files_with_the_same_policy_id(corpus: Path) -> None:
    source = (corpus / "08-escalation.md").read_text(encoding="utf-8")
    (corpus / "08-escalation.md").write_text(source.replace("REVIEW-01", "EMAIL-01"), encoding="utf-8")

    with pytest.raises(ValueError, match="Duplicate policy ID EMAIL-01: 07-email-drafts.md and 08-escalation.md"):
        load_corpus(corpus)
