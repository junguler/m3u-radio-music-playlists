#!/bin/bash

# find genre, cities, states and misc pages
curl -s https://radiostationusa.fm/formats | htmlq -a href a | grep "format" | sort | uniq | awk -F '/' '{print $2}' | awk NF > genres.txt
curl -s https://radiostationusa.fm/location | htmlq -a href a | grep "location" | sort | uniq | awk -F '/' '{print $2}' | awk NF > cities.txt
curl -s https://radiostationusa.fm/state | htmlq -a href a | grep "state" | sort | uniq | awk -F '/' '{print $2}' | awk NF > states.txt
echo "npr\n" "religious\n" "sports\n" "talk\n" "music\n" "online\n" | sed 's/ //g' | awk NF > misc.txt

# find the stream pages for genre, cities, states and misc
for i in "" \?page={2..15} ; do for j in $(cat genres.txt) ; do curl -s https://radiostationusa.fm/formats/$j$i | htmlq -a href a | grep "online" | awk -F '/' '{print $2}' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..5} ; do for j in $(cat cities.txt) ; do curl -s https://radiostationusa.fm/location/$j$i | htmlq -a href a | grep "online" | awk -F '/' '{print $2}' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..10} ; do for j in $(cat states.txt) ; do curl -s https://radiostationusa.fm/state/$j$i | htmlq -a href a | grep "online" | awk -F '/' '{print $2}' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..140} ; do for j in $(cat misc.txt) ; do curl -s https://radiostationusa.fm/$j$i | htmlq -a href a | grep "online" | awk -F '/' '{print $2}' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radiostationusa.fm/online/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep "class=\"play\"" | grep -Po 'url=*\K"[^"]*"' | sed 's/"//g' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done


# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
