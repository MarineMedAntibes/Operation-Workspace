"""Make a private offline copy/paste helper for numbered SQL import files."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    directory = args.directory.resolve()
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    files = []
    for item in manifest:
        path = (directory / item["file"]).resolve()
        if path.parent != directory or path.suffix != ".sql":
            raise ValueError("Unexpected SQL file path in manifest")
        sql = path.read_text(encoding="utf-8")
        files.append({"file": item["file"], "sql": sql, "bytes": path.stat().st_size})
    payload = json.dumps(files, ensure_ascii=True).replace("<", "\\u003c")
    html = r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Marine Medical — private SQL import</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#f3f7f7;color:#18343b;max-width:1100px;margin:40px auto;padding:0 20px}h1{font-size:28px}section{background:white;border:1px solid #cadbdb;border-radius:12px;padding:24px;margin:20px 0}select,button{font:inherit;padding:12px;border-radius:6px;border:1px solid #7a999c}select{width:100%;margin:10px 0}button{cursor:pointer;background:#164f59;color:white;margin:6px 10px 6px 0}textarea{display:block;box-sizing:border-box;width:100%;height:320px;white-space:pre;font:13px/1.5 monospace;margin-top:16px}#status{font-weight:600}small{color:#486368}</style>
<h1>Marine Medical — completed checks import</h1>
<p>This helper works offline and sends nothing to a database. Keep it private: it contains vessel and inventory data.</p>
<section><strong>Before importing</strong><ol><li>Run the database migration <code>202611200002_check_edits.sql</code> once (after the earlier migrations).</li><li>Review <code>completed-checks-report.json</code> and <code>completed-checks-issues.txt</code> in the parent folder.</li><li>For each file below: copy SQL, paste into Supabase SQL Editor, and run the <em>entire</em> contents. Wait for success before continuing.</li></ol><p>If a file fails, rerun that file after correcting the error. The import keeps existing matching records and edits. Do not clear the database.</p></section>
<section><label for="files"><strong>SQL file, in execution order</strong></label><select id="files"></select><p id="position"></p><button id="copy">Copy SQL</button><button id="next">I ran this file successfully — next</button><p id="status" role="status" aria-live="polite"></p><textarea id="sql" aria-label="SQL contents" readonly spellcheck="false"></textarea><small>Copy these contents only; the migration is a separate file. This helper cannot verify Supabase results.</small></section>
<script type="application/json" id="data">PAYLOAD</script>
<script>
const data=JSON.parse(document.getElementById('data').textContent), select=document.getElementById('files'), sql=document.getElementById('sql'), status=document.getElementById('status');
data.forEach((item,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=item.file;select.append(o);});
function show(){const i=Number(select.value), item=data[i];sql.value=item.sql;document.getElementById('position').textContent=`File ${i+1} of ${data.length} · ${Math.ceil(item.bytes/1024)} KB`;status.textContent='';}
select.onchange=show;
document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(sql.value);status.textContent='Copied. Paste into Supabase SQL Editor and run.';}catch{sql.focus();sql.select();try{status.textContent=document.execCommand('copy')?'Copied. Paste into Supabase SQL Editor and run.':'Press Ctrl+C to copy the selected SQL.';}catch{status.textContent='Press Ctrl+C to copy the selected SQL.';}}};
document.getElementById('next').onclick=()=>{const i=Number(select.value);if(i+1<data.length){select.value=String(i+1);show();}else{status.textContent='Last file reached. Refresh the app and review the imported records. This helper has not verified database results.';}};
show();
</script></html>'''.replace("PAYLOAD", payload)
    (directory / "IMPORT-HELPER.html").write_text(html, encoding="utf-8")
    print(f"Created offline import helper for {len(files)} SQL files.")


if __name__ == "__main__":
    main()
