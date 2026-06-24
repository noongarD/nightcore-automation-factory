import argparse
import difflib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def should_skip_plain_line(line: str) -> bool:
    stripped = line.strip()
    return not stripped or re.match(r"^\[[^\]]+\]$", stripped) is not None


def load_reference_lines(path: str) -> list[str]:
    raw = Path(path).read_text(encoding="utf-8-sig")
    lines = []
    for line in raw.splitlines():
        cleaned = clean_text(re.sub(r"<[^>]+>|\{[^}]+\}", "", line))
        if not should_skip_plain_line(cleaned):
            lines.append(cleaned)
    return lines


def tokenize(value: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", (value or "").lower())


def token_similarity(left: str, right: str) -> float:
    if left == right:
        return 1.0
    return difflib.SequenceMatcher(a=left, b=right, autojunk=False).ratio()


def soft_token_coverage(reference_tokens: list[str], candidate_tokens: list[str]) -> float:
    if not reference_tokens or not candidate_tokens:
        return 0.0
    scores = [
        max(token_similarity(token, candidate) for candidate in candidate_tokens)
        for token in reference_tokens
    ]
    return sum(scores) / len(scores)


def exact_token_coverage(reference_tokens: list[str], candidate_tokens: list[str]) -> float:
    if not reference_tokens or not candidate_tokens:
        return 0.0
    reference_counts = Counter(reference_tokens)
    candidate_counts = Counter(candidate_tokens)
    overlap = sum(min(count, candidate_counts[token]) for token, count in reference_counts.items())
    return overlap / len(reference_tokens)


def phrase_similarity(reference: str, candidate: str) -> float:
    reference_tokens = tokenize(reference)
    candidate_tokens = tokenize(candidate)
    if not reference_tokens or not candidate_tokens:
        return 0.0

    sequence_score = difflib.SequenceMatcher(
        a=" ".join(reference_tokens),
        b=" ".join(candidate_tokens),
        autojunk=False,
    ).ratio()
    soft_coverage = soft_token_coverage(reference_tokens, candidate_tokens)
    exact_coverage = exact_token_coverage(reference_tokens, candidate_tokens)
    return (sequence_score * 0.45) + (soft_coverage * 0.40) + (exact_coverage * 0.15)


def should_keep_segment(segment: dict) -> bool:
    text = clean_text(segment.get("text", ""))
    if not text:
        return False
    no_speech_prob = segment.get("no_speech_prob")
    avg_logprob = segment.get("avg_logprob")
    if isinstance(no_speech_prob, (int, float)) and no_speech_prob > 0.75:
        return False
    if isinstance(avg_logprob, (int, float)) and avg_logprob < -1.25:
        return False
    return True


def collect_segments(segments: list[dict]) -> list[dict]:
    collected = []
    for segment in segments:
        if not should_keep_segment(segment):
            continue
        text = clean_text(segment.get("text", ""))
        start = segment.get("start")
        end = segment.get("end")
        if start is None or end is None or not text:
            continue
        collected.append({
            "start": float(start),
            "end": float(end),
            "text": text,
        })
    return collected


def best_segment_match(
    line: str,
    segments: list[dict],
    cursor: int,
    search_window: int,
    max_span: int,
    minimum_score: float,
) -> dict | None:
    best = None
    search_end = min(len(segments), cursor + search_window)

    for start_index in range(cursor, search_end):
        combined_text = ""
        combined_start = segments[start_index]["start"]
        combined_end = segments[start_index]["end"]

        for span in range(1, max_span + 1):
            end_index = start_index + span - 1
            if end_index >= len(segments):
                break
            if end_index > start_index:
                gap = segments[end_index]["start"] - segments[end_index - 1]["end"]
                if gap > 1.1:
                    break

            combined_text = clean_text(f"{combined_text} {segments[end_index]['text']}")
            combined_end = segments[end_index]["end"]
            skip_penalty = (start_index - cursor) * 0.045
            span_penalty = (span - 1) * 0.045
            score = phrase_similarity(line, combined_text) - skip_penalty - span_penalty
            if best is None or score > best["score"]:
                best = {
                    "start": combined_start,
                    "end": combined_end,
                    "text": combined_text,
                    "score": score,
                    "startIndex": start_index,
                    "endIndex": end_index,
                }

    if best and best["score"] >= minimum_score:
        return best
    return None


def align_lines_to_segments(reference_lines: list[str], segments: list[dict]) -> list[dict | None]:
    if not reference_lines or not segments:
        return [None] * len(reference_lines)

    raw_timings = []
    cursor = 0

    for line in reference_lines:
        match = best_segment_match(
            line=line,
            segments=segments,
            cursor=cursor,
            search_window=10,
            max_span=1,
            minimum_score=0.43,
        )

        if match is None:
            raw_timings.append(None)
            continue

        raw_timings.append({
            "start": match["start"],
            "end": match["end"],
            "text": line,
            "matchedTokens": round(match["score"], 3),
            "matchedSegment": match["text"],
        })
        cursor = match["endIndex"] + 1

    return raw_timings


def best_word_span_match(
    line: str,
    words: list[dict],
    cursor: int,
    search_window: int,
    minimum_score: float,
) -> dict | None:
    reference_tokens = tokenize(line)
    if not reference_tokens:
        return None

    expected_len = len(reference_tokens)
    min_span = max(1, expected_len - 2)
    max_span = min(14, expected_len + 4)
    search_end = min(len(words), cursor + search_window)
    best = None

    for start_index in range(cursor, search_end):
        for span in range(min_span, max_span + 1):
            end_index = start_index + span - 1
            if end_index >= len(words):
                break
            if end_index >= search_end + max_span:
                break

            span_words = words[start_index:end_index + 1]
            candidate_text = " ".join(word["token"] for word in span_words)
            skip_penalty = (start_index - cursor) * 0.018
            length_penalty = abs(span - expected_len) * 0.025
            score = phrase_similarity(line, candidate_text) - skip_penalty - length_penalty

            if best is None or score > best["score"]:
                best = {
                    "start": span_words[0]["start"],
                    "end": span_words[-1]["end"],
                    "text": candidate_text,
                    "score": score,
                    "startIndex": start_index,
                    "endIndex": end_index,
                }

    if best and best["score"] >= minimum_score:
        return best
    return None


def align_lines_to_words(reference_lines: list[str], words: list[dict]) -> list[dict | None]:
    if not reference_lines or not words:
        return [None] * len(reference_lines)

    raw_timings = []
    cursor = 0

    for line in reference_lines:
        match = best_word_span_match(
            line=line,
            words=words,
            cursor=cursor,
            search_window=38,
            minimum_score=0.46,
        )

        if match is None:
            raw_timings.append(None)
            continue

        raw_timings.append({
            "start": match["start"],
            "end": match["end"],
            "text": line,
            "matchedTokens": round(match["score"], 3),
            "matchedSegment": match["text"],
        })
        cursor = match["endIndex"] + 1

    return raw_timings


def collect_words(segments: list[dict]) -> list[dict]:
    words = []
    for segment in segments:
        if not should_keep_segment(segment):
            continue
        for word in segment.get("words") or []:
            raw = clean_text(word.get("word", ""))
            start = word.get("start")
            end = word.get("end")
            if not raw or start is None or end is None:
                continue
            tokens = tokenize(raw)
            for token in tokens:
                words.append({
                    "token": token,
                    "word": raw,
                    "start": float(start),
                    "end": float(end),
                })
    return words


def estimate_block(lines: list[str], cursor: float, available: float) -> list[dict]:
    weights = [max(1.2, len(tokenize(line)) * 0.55) for line in lines]
    total = sum(weights) or 1
    available = max(available, len(lines) * 1.0)
    result = []
    for line, weight in zip(lines, weights):
        seconds = max(0.75, available * weight / total)
        result.append({"start": cursor, "end": cursor + seconds, "text": line, "matchedTokens": 0})
        cursor += seconds
    return result


def fill_missing(lines: list[str], raw_timings: list[dict | None], duration: float | None) -> list[dict]:
    result = list(raw_timings)
    index = 0
    while index < len(result):
        if result[index] is not None:
            index += 1
            continue

        start = index
        while index < len(result) and result[index] is None:
            index += 1
        end = index

        prev_line = result[start - 1] if start > 0 else None
        next_line = result[end] if end < len(result) else None
        block_lines = lines[start:end]

        cursor = prev_line["end"] + 0.12 if prev_line else 0.0
        if next_line:
            available = max(0.75 * len(block_lines), next_line["start"] - cursor - 0.08)
        elif duration is not None and duration > cursor:
            available = max(0.75 * len(block_lines), duration - cursor)
        else:
            available = sum(max(1.2, len(tokenize(line)) * 0.55) for line in block_lines)

        estimated = estimate_block(block_lines, cursor, available)
        for offset, item in enumerate(estimated):
            result[start + offset] = item

    cleaned = []
    for item in result:
        if item is None:
            continue
        cleaned.append({
            "start": float(item["start"]),
            "end": float(item["end"]),
            "text": item["text"],
            "matchedTokens": item.get("matchedTokens", 0),
            **({"matchedSegment": item["matchedSegment"]} if item.get("matchedSegment") else {}),
        })

    for i, item in enumerate(cleaned):
        if i > 0 and item["start"] < cleaned[i - 1]["start"] + 0.25:
            item["start"] = cleaned[i - 1]["start"] + 0.25
        if item["end"] <= item["start"]:
            item["end"] = item["start"] + 0.75
        if i + 1 < len(cleaned) and item["end"] > cleaned[i + 1]["start"] - 0.08:
            item["end"] = max(item["start"] + 0.75, cleaned[i + 1]["start"] - 0.08)

    return cleaned


def align_reference_lines(reference_lines: list[str], segments: list[dict]) -> list[dict]:
    recognized_words = collect_words(segments)
    word_timings = align_lines_to_words(reference_lines, recognized_words)
    word_matches = sum(1 for item in word_timings if item is not None)

    if word_matches >= max(2, len(reference_lines) * 0.35):
        duration = recognized_words[-1]["end"] if recognized_words else None
        return fill_missing(reference_lines, word_timings, duration)

    recognized_segments = collect_segments(segments)
    segment_timings = align_lines_to_segments(reference_lines, recognized_segments)
    segment_matches = sum(1 for item in segment_timings if item is not None)

    if segment_matches >= max(2, len(reference_lines) * 0.35):
        duration = recognized_segments[-1]["end"] if recognized_segments else None
        return fill_missing(reference_lines, segment_timings, duration)

    recognized_tokens = [word["token"] for word in recognized_words]
    reference_tokens = []
    line_token_indexes = []

    for line in reference_lines:
        indexes = []
        for token in tokenize(line):
            indexes.append(len(reference_tokens))
            reference_tokens.append(token)
        line_token_indexes.append(indexes)

    if not reference_tokens or not recognized_tokens:
        duration = recognized_words[-1]["end"] if recognized_words else None
        return fill_missing(reference_lines, [None] * len(reference_lines), duration)

    matcher = difflib.SequenceMatcher(a=reference_tokens, b=recognized_tokens, autojunk=False)
    matches_by_reference_index = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            matches_by_reference_index[block.a + offset] = recognized_words[block.b + offset]

    raw_timings = []
    for line, token_indexes in zip(reference_lines, line_token_indexes):
        matched_words = [
            matches_by_reference_index[index]
            for index in token_indexes
            if index in matches_by_reference_index
        ]
        if not matched_words:
            raw_timings.append(None)
            continue
        raw_timings.append({
            "start": matched_words[0]["start"],
            "end": matched_words[-1]["end"],
            "text": line,
            "matchedTokens": len(matched_words),
        })

    duration = recognized_words[-1]["end"] if recognized_words else None
    return fill_missing(reference_lines, raw_timings, duration)


def group_words(words: list[dict], max_words: int, max_seconds: float) -> list[dict]:
    lines = []
    current = []

    def flush():
        nonlocal current
        if not current:
            return
        text = clean_text(" ".join(word["word"].strip() for word in current))
        if text:
            lines.append({
                "start": float(current[0]["start"]),
                "end": float(current[-1]["end"]),
                "text": text,
            })
        current = []

    previous_end = None
    for word in words:
        text = clean_text(word.get("word", ""))
        start = word.get("start")
        end = word.get("end")
        if not text or start is None or end is None:
            continue

        gap = 0 if previous_end is None else float(start) - float(previous_end)
        current_duration = 0 if not current else float(end) - float(current[0]["start"])
        ends_sentence = bool(current and re.search(r"[.!?]$", current[-1]["word"].strip()))

        if current and (gap > 0.85 or len(current) >= max_words or current_duration >= max_seconds or ends_sentence):
            flush()

        current.append({"word": text, "start": float(start), "end": float(end)})
        previous_end = float(end)

    flush()
    return lines


def segments_to_lines(segments: list[dict], max_words: int, max_seconds: float) -> list[dict]:
    words = []
    for segment in segments:
        if not should_keep_segment(segment):
            continue
        for word in segment.get("words") or []:
            words.append(word)

    if words:
        return group_words(words, max_words=max_words, max_seconds=max_seconds)

    lines = []
    for segment in segments:
        if not should_keep_segment(segment):
            continue
        start = segment.get("start")
        end = segment.get("end")
        text = clean_text(segment.get("text", ""))
        if start is None or end is None or not text:
            continue
        lines.append({"start": float(start), "end": float(end), "text": text})
    return lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--max-words", type=int, default=7)
    parser.add_argument("--max-seconds", type=float, default=4.2)
    parser.add_argument("--lyrics", default="")
    args = parser.parse_args()

    audio_path = Path(args.audio)
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    import torch
    import whisper

    if args.device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = args.device

    model = whisper.load_model(args.model, device=device)
    transcribe_options = {
        "word_timestamps": True,
        "fp16": device == "cuda",
        "verbose": False,
    }
    if args.language:
        transcribe_options["language"] = args.language

    result = model.transcribe(str(audio_path), **transcribe_options)
    reference_lines = load_reference_lines(args.lyrics) if args.lyrics else []
    if reference_lines:
        lines = align_reference_lines(reference_lines, result.get("segments", []))
        timing_mode = "whisper-align"
    else:
        lines = segments_to_lines(result.get("segments", []), args.max_words, args.max_seconds)
        timing_mode = "whisper"

    payload = {
        "version": 1,
        "source": str(audio_path),
        "lyricsSource": str(Path(args.lyrics)) if args.lyrics else "",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "timingMode": timing_mode,
        "model": args.model,
        "device": device,
        "language": result.get("language"),
        "lines": lines,
    }

    output_path = Path(args.output)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": "ready" if lines else "empty",
        "output": str(output_path),
        "lines": len(lines),
        "timingMode": timing_mode,
        "model": args.model,
        "device": device,
        "language": payload["language"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
