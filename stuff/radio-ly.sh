#!/bin/bash

# get a list of genres, countries and languages
curl -s https://radioly.app/sitemap/language.xml | htmlq loc -t | awk -F '/' '{print $5}' > languages.txt
curl -s https://radioly.app/sitemap/genre.xml | htmlq loc -t | awk -F '/' '{print $5}' > genres.txt
curl -s https://radioly.app/sitemap/country.xml | htmlq loc -t | awk -F '/' '{print $5}' > countries.txt

# get the list of all radio names from each page
for i in {1..60} ; do for j in $(cat genres.txt) ; do curl -s https://radioly.app/genre/$j/$i/ | htmlq "#pb_main > div > div > div.pb-card-list" -a href a | grep '/radio/' | awk '!seen[$0]++' | awk -F '/' '{print $5}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in {1..100} ; do for j in $(cat countries.txt) ; do curl -s https://radioly.app/country/$j/$i/ | htmlq "#pb_main > div > div > div.pb-card-list" -a href a | grep '/radio/' | awk '!seen[$0]++' | awk -F '/' '{print $5}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in {1..130} ; do for j in $(cat languages.txt) ; do curl -s https://radioly.app/language/$j/$i/ | htmlq "#pb_main > div > div > div.pb-card-list" -a href a | grep '/radio/' | awk '!seen[$0]++' | awk -F '/' '{print $5}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scrape radio title, logo and stream link
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radioly.app/radio/$j/ > mep1 ; paste -d ',' <(cat mep1 | grep -oP 'meta property="og:image" content="\K[^"]*' | awk '{ print "\"" $0 "\"" }') <(cat mep1 | htmlq -t h1) | awk 'NR==1 {$0="#EXTINF:-1 tvg-logo=" $0} 1' >> A$i ; cat mep1 | grep -oP 'data-audio-url="\K[^"]*' | head -n 1 | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert files to m3u extension
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA and double extensions from files
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
