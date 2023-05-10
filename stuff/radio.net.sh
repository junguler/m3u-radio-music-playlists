#!/bin/bash

# scrape the links
curl https://www.radio.net/genre | grep -oP 'href="\K[^"]+' | grep "https://www.radio.net/genre/" | sort | uniq | cut -c29- > genres.txt

# get the links for the webpages
for i in "" \?p={2..25} ; do for j in $(cat genres.txt) ; do curl -s https://www.radio.net/genre/$j$i | htmlq -a href a | grep "https://www.radio.net/s/" | sed "1,20d" | tac | sed "1,30d" | tac | cut -c25- >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# remove duplicates links and cut the last 9 stream that are the same in each page
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | tac | sed "1,9d" | tac > A$i ; echo -e $i ; done

# scrape the links from each text file to a m3u output
for i in AA-*.txt ; do for j in $(cat $i) ; do curl -s https://www.radio.net/s/$j > mep1 ; cat mep1 | htmlq -t h1 | uniq | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep "id=\"__NEXT_DATA__\"" | grep -Po '"url": *\K"[^"]*"' | sed 's/\"//g' | grep "/" | grep -v "radio.net" | head -n 1 | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
