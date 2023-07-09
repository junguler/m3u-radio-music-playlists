#!/bin/bash

# find genres, countries and languages
curl -s https://vo-radio.com/genres | htmlq -a href a | grep "genres" | sort | awk -F '/' {'print $3}' | awk NF > genres.txt
curl -s https://vo-radio.com/usa | htmlq -a href a | grep "usa/" | sort | uniq | awk -F '/' '{print $2}' | awk NF > states.txt

# find pages for each category
for i in "" \?page={2..10} ; do for j in $(cat genres.txt) ; do curl -s https://vo-radio.com/genres/$j$i | htmlq -a href a | uniq | grep -v "page\|privacy" | awk 'length>8' | cut -c2- >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..5} ; do for j in $(cat states.txt) ; do curl -s https://vo-radio.com/usa/$j$i | htmlq -a href a | uniq | grep -v "page\|privacy" | awk 'length>8' | cut -c2- >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://vo-radio.com/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep "source src=" | awk -F '"' '{print $2}' | sed 's/"//g' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
