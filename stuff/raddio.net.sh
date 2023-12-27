#!/bin/bash

# get a list of genres, countries and languages
curl -s https://raddio.net/genres/ | htmlq -a href a | grep "genre/" | awk -F '/' '{print $3}' | sort | uniq > main-genres.txt
for i in $(cat main-genres.txt) ; do curl -s https://raddio.net/genre/$i/ | htmlq -a href a | grep "genre/" | grep -v "sorting" | awk -F '/' '{print $3}' | sort | uniq >> sub-genres.txt ; done
curl -s https://raddio.net/languages/ | htmlq -a href a | grep "language/" | awk -F '/' '{print $3}' | sort | uniq > languages.txt
curl -s https://raddio.net/regions/ | htmlq -a href a | grep "country" | awk -F '/' '{print $3}' | sort | uniq > countries.txt

# get the links to genres
for i in "" {1..99}/ ; do for j in $(cat main-genres.txt sub-genres.txt) ; do curl -s https://raddio.net/genre/$j/$i | htmlq .content -a href a | grep -v "sorting\|genre" | awk 'length>4' | sed 's|/||g' >> A-$j.txt ; done ; done

# get the links to countires
for i in "" {1..99}/ ; do for j in $(cat countries.txt) ; do curl -s https://raddio.net/country/$j/$i | htmlq .content -a href a | grep -v "sorting\|country" | awk 'length>4' | sed 's|/||g' >> A-$j.txt ; done ; done

# get the links to languages
for i in "" {1..99}/ ; do for j in $(cat languages.txt) ; do curl -s https://raddio.net/language/$j/$i | htmlq .content -a href a | grep -v "sorting\|languages" | awk 'length>4' | sed 's|/||g' >> A-$j.txt ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://raddio.net/$j/ > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "var realStreams" | awk -F '"' '{print $4}' | sed 's|\\||g' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
