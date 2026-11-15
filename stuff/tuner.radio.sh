# get the list of genres
curl -s https://www.tuner-radio.com/script/full_genre.js | tr -d '\r' | sed -n '/rawGenres *= *\[/,/\];/p' | grep -o '"[^"]*"' | tr -d '"' | tr ' ' '-' | sort | uniq > genres.txt

# get all station ids for genres
for i in "" \?page={2..50} ; do for j in $(cat genres.txt) ; do curl -s https://www.tuner-radio.com/genre/category/$j$i | htmlq -a href a | grep '/station/' | cut -c10- >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scrape everything
for i in A-*.txt ; do name="${i#A-}" ; name="${name%.txt}.m3u" ; while IFS= read -r j || [ -n "$j" ] ; do curl -s "https://www.tuner-radio.com/station/$j" > mep1 ; c="${j%%/*}" ; cl="${c}.m3u" ; t=$(grep -oP '"name":"\K[^"]+' mep1 | head -n 1 | sed 's/\\[tnr]//g' | awk '{$1=$1} ; NF') ; u=$(grep -oP '"url":"\K[^"]+' mep1 | head -n 1) ; for f in "$name" "$cl" ; do [ -s "$f" ] || echo "#EXTM3U" > "$f" ; printf '#EXTINF:-1,%s\n%s\n' "$t" "$u" >> "$f" ; done ; printf '%s - %s\n' "$i" "$j" ; done < "$i" ; done
