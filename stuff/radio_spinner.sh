# get the list of genres and countries
curl -s https://radiospinner.com/genres/ | htmlq -a href a | grep '/genres/' | awk -F '/' '{print $3}' | sort | uniq > genres.txt
for i in 'africa' 'asia' 'europe' 'north-america' 'south-america' 'oceania' ; do curl -s https://radiospinner.com/$i/ > hold ; paste -d '|' <(cat hold | htmlq -a data-country '.country-chip' | tr '[:upper:]' '[:lower:]') <(cat hold | htmlq '.country-chip .chip-title' --text) | sed -e 's| |_|g'  -e 's/|/___/g' >> countries.txt ; done

# get the list of all stations
for i in {1..25} ; do for j in $(cat genres.txt) ; do curl -s "https://radiospinner.com/genres/$j/?sort=rating&page=$i&ajax=1" | htmlq -a href .category-stations a | awk '!seen[$0]++' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in {1..25} ; do for j in $(cat countries.txt) ; do curl -s "https://radiospinner.com/$(echo $j | awk -F '___' '{print $1}')/?sort=rating&page=$i&ajax=1" | htmlq -a href .country-stations a | awk '!seen[$0]++' >> A-$(echo $j | awk -F '___' '{print $2}').txt ; echo -e "$j - $i" ; done ; done

# scrape everything
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radiospinner.com$j > mep1 ; paste -d ',' <(cat mep1 | grep 'data-logo-url' | cut -d '"' -f 2 | sed 's/\?.*$//' | awk '{ print "\"" $0 "\"" }') <(cat mep1 | grep 'data-station-name' | cut -d '"' -f 2) | awk 'NR==1 {$0="#EXTINF:-1 tvg-logo=" $0} 1' >> A$i ; cat mep1 | grep 'data-stream-url1' | cut -d '"' -f 2 | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# exclude streams that didn't have links
for i in *.txt ; do awk '!seen[$0]++{if(p&&/^https?:\/\//){print l;print}if($0~/^#EXTINF:/){p=1;l=$0;next}{p=0}}' "$i" > "A$i"; echo "$i" ; done

# make the playlists proper by adding the header
for i in *.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove extra fluff from filenames
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's|AAA-||g' -e 's|.txt||g'`" ; done