#!/bin/bash

# find genres and countries
curl -s https://radiovolna.net/en/genre/ | htmlq -a href a | grep "en/genre/" | sort | awk -F '/' '{print $4}' | awk NF > genres.txt
curl -s https://radiovolna.net/en/countries/ | htmlq -a href a | grep "/en/" | grep -v ".html" | sort | awk -F '/' '{print $3}' | awk NF > countries.txt

# find pages for each category
for i in "" {1..50}/ ; do for j in $(cat genres.txt) ; do curl -s https://radiovolna.net/en/genre/$j/$i | htmlq -a href a | grep ".html" | grep '[[:digit:]]\+' | awk -F '/' '{print $3}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" {1..4}/ ; do for j in $(cat countries.txt) ; do curl -s https://radiovolna.net/en/$j/$i | htmlq -a href a | grep ".html" | grep '[[:digit:]]\+' | awk -F '/' '{print $3}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radiovolna.net/en/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep 'data-stream-url' | awk -F '"' '{print $2}' | sed 's/"//g' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
