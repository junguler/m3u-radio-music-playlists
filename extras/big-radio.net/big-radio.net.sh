#!/bin/bash

# get a list of genre and country names
curl -s https://big-radio.net/genres.html | htmlq -a href a | grep '/online-radio/' | awk -F '/' '{print $3}' | awk NF > genres.txt
curl -s https://big-radio.net/countries.html | htmlq -a href a | grep '/radio/' | awk -F '/' '{print $3}' | awk NF > countries.txt

# scrape stream names from each of genre and country txt files
for i in "" page/{2..25}/ ; do for j in $(cat genres.txt) ; do curl -s https://big-radio.net/online-radio/$j/$i | htmlq 'body > div.content_go > div.container_content > div' -a href a | grep -v '/page/' | awk 'length($0) >= 32' | awk -F '/' '{print $NF}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" page/{2..25}/ ; do for j in $(cat countries.txt) ; do curl -s https://big-radio.net/radio/$j/$i | htmlq 'body > div.content_go > div.container_content > div' -a href a | grep -v '/page/' | awk 'length($0) >= 32' | awk -F '/' '{print $NF}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scrape radio title and stream link from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -L -s https://big-radio.net/online-radio/$j > mep1 ; cat mep1 | htmlq -t h1 | awk 'NR==1 {$0="#EXTINF:-1," $0} 1' >> A$i ; cat mep1 | grep -oP '(?<=file:")[^"]*' | sed 's/ or.*//' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# replace %20 in filenames with underline
for i in *.m3u ; do mv $i $(echo $i | sed 's|%20|_|g') ; done