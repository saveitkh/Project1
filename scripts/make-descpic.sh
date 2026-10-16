#!/usr/bin/env bash
# Makes the 640x360 MP4 shown above the bot's description (the banner in an
# empty chat). The Bot API cannot set it: send the result to @BotFather ->
# /setdescriptionpic -> pick the bot -> upload the file.
#
#   scripts/make-descpic.sh input.mp4 [output.mp4] [start_seconds]
#
# Centre-cropped to 16:9, 640x360, H.264, no audio, at most 10 s.
set -euo pipefail
in="${1:?usage: make-descpic.sh input.mp4 [output.mp4] [start_seconds]}"
out="${2:-descpic-640x360.mp4}"
start="${3:-0}"
ffmpeg -y -loglevel error -ss "$start" -t 10 -i "$in" \
  -vf "scale=640:360:force_original_aspect_ratio=increase:flags=lanczos,crop=640:360,fps=30" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -crf 26 -movflags +faststart -an "$out"
echo "Wrote $out ($(du -h "$out" | cut -f1)) -- upload it in @BotFather with /setdescriptionpic"
