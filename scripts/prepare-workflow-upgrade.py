"""Combine the additive workflow migration and private rates into one transaction."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
schema = root / "supabase/migrations/202611200003_workflow.sql"
rates = root / "private-import/rate-rules.sql"
if not rates.exists():
    raise SystemExit("Prepare private rate-rules.sql first, or apply the schema migration alone and enter rates in Setup.")


def body(path):
    text = path.read_text(encoding="utf-8")
    text, count = re.subn(r"(?im)^begin;\s*$", "", text, count=1)
    if count != 1:
        raise ValueError(f"Expected one outer transaction in {path.name}")
    text, count = re.subn(r"(?im)^commit;\s*$", "", text, count=1)
    if count != 1:
        raise ValueError(f"Expected one outer commit in {path.name}")
    return text


output = root / "private-import/workflow-upgrade.sql"
output.write_text("-- PRIVATE: workflow schema plus internal rate suggestions. Apply ONCE after the earlier migrations.\n-- Existing clients, checks and stock are retained. No historical import needs rerunning.\nBEGIN;\n" + body(schema) + "\n" + body(rates) + "\nCOMMIT;\n", encoding="utf-8")
print(f"Prepared {output.name}: {output.stat().st_size:,} bytes. Apply once in Supabase SQL Editor.")
