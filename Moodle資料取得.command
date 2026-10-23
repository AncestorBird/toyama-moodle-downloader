#!/bin/zsh
cd -- "${0:A:h}" || exit 1
python3 tools/moodle_download.py
result=$?
printf '\n終了コード: %s\nEnterキーで閉じられます。' "$result"
read -r
exit "$result"
