#!/bin/zsh
cd -- "${0:A:h}" || exit 1
exec ./Moodle資料取得.command --assignments "$@"
