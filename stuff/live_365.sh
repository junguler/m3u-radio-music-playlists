#!/bin/bash

# get a list of genre
curl -s https://api.live365.com/genres | jq -r '.[]' | grep "name" | awk -F '"' '{print $4}' | tr '[:upper:]' '[:lower:]' | sed -e 's/ /-/g' -e "s/'//g" -e 's/\//-/g' -e 's/&/n/g' > genres.txt

# scrape stream names from each page
for i in $(cat genres.txt) ; do curl -s https://live365.com/listen/$i-radio | htmlq -a href a | grep "station" | grep -v "broadcaster" | uniq | awk -F '/' '{print $3}' | uniq > A-$i.txt ; done

# the above line only scrapes the first page of each genre files since more content is loaded via js code, rest assured i've scraped every page for each genre but the code is not here for that specific operation as it's not in bash

# scrape everything
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://live365.com/station/$j > mep1 ; cat mep1 | htmlq -t h1 | head -n 1 | awk '{print "#EXTINF:-1,"$0}' | uniq >> A$i ; cat mep1 | grep -Po '"streamUrl": *\K"[^"]*"' | sed 's/"//g' | sed 's/\;//g' | sed '/^$/d' | xargs curl -s -I | grep "location" | awk '{print $2}' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
