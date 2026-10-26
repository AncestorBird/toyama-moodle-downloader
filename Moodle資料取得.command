#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if [[ -x .venv/bin/python ]]; then
    .venv/bin/python tools/moodle_download.py
else
    python3 tools/moodle_download.py
fi
result=$?
printf '\n終了コード: %s\nEnterキーで閉じられます。' "$result"
read -r
exit "$result"
