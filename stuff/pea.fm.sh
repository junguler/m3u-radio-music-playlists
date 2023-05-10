#!/bin/bash

# find genre and country pages
curl -s https://pea.fm/genres.html | htmlq -a href a | awk -F '/' '{print $4}' | grep -vi ".html\|php\|pea\|store\|podcast" | awk NF | awk 'length>2' | uniq > genres.txt
curl -s https://pea.fm/country.html | htmlq -a href a | awk -F '/' '{print $4}' | grep -vi ".html\|php\|pea\|store\|podcast" | awk NF | awk 'length>2' | uniq > country.txt

# find the stream page for genres and countries
for i in "" page/{2..200}/ ; do for j in $(cat genres.txt) ; do curl -s https://pea.fm/$j/$i | htmlq -a href a | grep ".html" | grep "pea.fm" | uniq | cut -c16- | rev | cut -c6- | rev | sed -e 's/ /%20/g' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" page/{2..200}/ ; do for j in $(cat country.txt) ; do curl -s https://pea.fm/radio/$j/$i | htmlq -a href a | grep ".html" | uniq | cut -c16- | rev | cut -c6- | rev | sed -e 's/ /%20/g' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://pea.fm/$j.html > mep1 ; cat mep1 | htmlq -t h1 | cut -c2- | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep "streamurl" | uniq | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove stream titles that don't have a stream after them
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
