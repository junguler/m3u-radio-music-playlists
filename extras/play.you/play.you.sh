#!/bin/bash

# get the list of all streams
curl -s https://play.you.radio/all-stations | htmlq .listings td | awk '{if(NR%2==1) {line=$0} else {print line, $0}}' > hold.txt

# create genres
paste -d '-' <(cat hold.txt | htmlq -a href a | awk -F '/' '{print $3}') <(cat hold.txt | awk -F '<td>' '{print $3}' | htmlq -t) | sed 's| |_|g;s|-|---|g' | awk 'length>3' > genres.txt

# extract stream links and name
for i in $(cat genres.txt) ; do curl -s https://play.you.radio/station_name/$(echo $i | awk -F '---' '{print $1}') | awk 'NR==1 {$0="#EXTINF:-1," $0} 1' >> A-$(echo $i | awk -F '---' '{print $2}').txt ; curl -s https://play.you.radio/player_stream/$(echo $i | awk -F '---' '{print $1}') >> A-$(echo $i | awk -F '---' '{print $2}').txt ; echo -e "\n" >> A-$(echo $i | awk -F '---' '{print $2}').txt ; echo -e $i ; done

# remove streams that didn't have links
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
