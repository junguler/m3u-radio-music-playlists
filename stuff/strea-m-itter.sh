# extract the list of all stations from the sitemap
cat https://radio.streamitter.com/sitemap-stations.php | htmlq loc -t | sort | uniq | awk -F '/' '{print $5}' > stations.txt

# scrape stream logo, title and link and insert it to their country and genre files
for i in $(cat *.txt) ; do curl -s https://radio.streamitter.com/station/$i > mep1 ; paste -d ',' <(cat mep1 | htmlq -a src 'img[title]' | sed 's/\?.*$//; s|^|https://radio.streamitter.com|' | head -n 1 | awk '{ print "\"" $0 "\"" }') <(cat mep1 | htmlq -t h1 | head -n 1) | awk 'NR==1 {$0="#EXTINF:-1 tvg-logo=" $0} 1' | tee -a $(cat mep1 | htmlq -a href a | grep '/genre/' | cut -d '/' -f 3 | head -n 1).m3u $(cat mep1 | htmlq -a href a | grep '/location/' | cut -d '/' -f 3 | head -n 1).m3u > /dev/null ; cat mep1 | htmlq audio -a src | sed 's/\;//g' | sed '/^$/d' | tee -a $(cat mep1 | htmlq -a href a | grep '/genre/' | cut -d '/' -f 3 | head -n 1).m3u $(cat mep1 | htmlq -a href a | grep '/location/' | cut -d '/' -f 3 | head -n 1).m3u > /dev/null ; echo $i ; done

# exclude streams that didn't have links
for i in *.m3u; do awk '!seen[$0]++{if(p&&/^https?:\/\//){print l;print}if($0~/^#EXTINF:/){p=1;l=$0;next}{p=0}}' "$i" > "A-$i"; echo "$i"; done

# make the playlists proper by adding the header
for i in *.m3u ; do sed '1s/^/#EXTM3U\n/' $i > A$i ; done

# remove extra fluff from filenames
for i in *.m3u ; do mv "$i" "`echo $i | sed 's/AA-//'`" ; done