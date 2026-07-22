# get the list of all the stations
for i in {1..6} ; do curl -s https://wavelyradio.cz/sitemap-stations-$i.xml > $i.xml ; done
for i in *.xml ; do cat $i | htmlq loc -t | awk -F '/' '{print $NF}' >> stations.txt ; done

# scrape everything
for i in $(cat stations.txt) ; do curl -s https://wavelyradio.cz/app/station/$i > mep1 ; u=$(grep data-url mep1 | head -n1 | awk -F '"' '{print $2}') ; l=$(grep data-logo mep1 | head -n1 | awk -F '"' '{print $2}') ; t=$(grep data-name mep1 | head -n1 | awk -F '"' '{print $2}') ; [ -z "$u" ] && continue ; for tag in $(cat mep1 | htmlq 'div.flex.flex-wrap.gap-2.mt-4' -t | sed 's| |_|g' | sed 's|__||g' | awk NF) ; do f="$tag.m3u"; [ -f "$f" ] || echo "#EXTM3U" > "$f" ; echo "#EXTINF:-1 tvg-logo=\"$l\",$t" >> "$f" ; echo "$u" >> "$f" ; done ; done