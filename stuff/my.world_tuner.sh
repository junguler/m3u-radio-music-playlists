# get the list of everything from the sitemap
curl -s https://myworldtuner.com/sitemap-directories.xml | htmlq loc -t | awk -F '/' '{print $4"/"$5}' | sort > list.txt

# scrape everything
for i in *.txt ; do printf '#EXTM3U\n' > "${i%.txt}.m3u"; for j in $(cat "$i") ; do curl -Ls --connect-timeout 10 --max-time 20 "https://myworldtuner.com/station/$j/" > mep1 2>/dev/null; t=$(cat mep1 | htmlq -t h1 | head -n 1 | sed 's| live||g' | sed 's/[[:space:]]\+/ /g;s/^ *//;s/ *$//') ; s=$(cat mep1 | htmlq -a data-stream '.js-play' | head -n 1 | sed 's| live||g') ; if [ -n "$s" ] ; then printf '#EXTINF:-1,%s\n%s\n' "${t:-$j}" "$s" >> "${i%.txt}.m3u" ; fi; echo "$i - $j" ; done ; done