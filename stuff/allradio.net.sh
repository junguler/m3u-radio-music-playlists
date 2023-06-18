#!/bin/bash

# find genres, countries and languages
curl -s https://www.allradio.net/category | htmlq span | grep "category" | awk -F '"' '{print $6"_"$8}' | cut -c11- | sed -e 's/ /-/g' -e 's/ /-/g' | awk NF > genres.txt
curl -s https://www.allradio.net/language | htmlq span | grep "language" | awk -F '"' '{print $6"_"$8}' | cut -c11- | sed -e 's/ /-/g' -e 's/ /-/g' | awk NF > languages.txt
curl -s https://www.allradio.net/country | htmlq span | grep "country" | awk -F '"' '{print $6"_"$8}' | cut -c10- | sed -e 's/ /-/g' -e 's/ /-/g' | awk NF > countries.txt

# find pages for each category
for i in "" /{2..50} ; do for j in $(cat genres.txt) ; do curl -s "https://www.allradio.net/category/$(echo $j | awk -F '_' '{print $1}')$i" | htmlq -a href a | uniq | grep "radio" | awk -F '/' '{print $3}' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" /{2..50} ; do for j in $(cat languages.txt) ; do curl -s "https://www.allradio.net/language/$(echo $j | awk -F '_' '{print $1}')$i" | htmlq -a href a | uniq | grep "radio" | awk -F '/' '{print $3}' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" /{2..50} ; do for j in $(cat countries.txt) ; do curl -s "https://www.allradio.net/country/$(echo $j | awk -F '_' '{print $1}')$i" | htmlq -a href a | uniq | grep "radio" | awk -F '/' '{print $3}' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://www.allradio.net/radio/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep -Po '"stream": *\K"[^"]*"' | sed 's/"//g' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

# remove the numbered prefix while avoiding overrite of files with similar names
for i in *.m3u ; do mv -i "$i" "`echo $i | sed -e 's/.*_//'`" ; done
